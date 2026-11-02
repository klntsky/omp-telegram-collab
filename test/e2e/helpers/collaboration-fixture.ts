import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { Message } from '@mtcute/node';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import { connectCollab } from '../../../src/collab.js';
import { BotService } from '../../../src/bot.js';
import { emptyConfig, writeConfig } from '../../../src/config.js';
import { OmpRuntime } from '../../../src/runtime.js';
import { Store } from '../../../src/store.js';
import type { FakeLlmStep } from './fake-llm-provider.js';
import { setupOmpEnvironment } from './omp-environment.js';
import { setupTelegramTest } from './telegram-fixture.js';

const operationTimeoutMs = 120_000;
const cleanupTimeoutMs = 30_000;

type Cleanup = () => unknown | Promise<unknown>;

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([operation, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function setupCollaborationTest(
  t: Pick<TestContext, 'after' | 'signal' | 'diagnostic' | 'mock'>,
  options: { steps: readonly FakeLlmStep[] },
) {
  const telegramCleanup: Cleanup[] = [];
  const ompCleanup: Cleanup[] = [];
  let service: BotService | undefined;
  let runtime: OmpRuntime | undefined;
  let store: Store | undefined;
  let unsubscribe: Cleanup | undefined;
  let polling: Promise<void> | undefined;
  let closing = false;
  let log: ((event: string, data: unknown) => void) | undefined;
  const restoreConsole: Cleanup[] = [];
  const failure = Promise.withResolvers<never>();
  const failed = new AbortController();
  void failure.promise.catch(() => undefined);
  const fail = (error: unknown) => {
    log?.('application.error', error);
    failed.abort(error);
    failure.reject(error);
  };
  const operation = <T>(promise: Promise<T>, timeoutMs = operationTimeoutMs) => bounded(
    Promise.race([promise, failure.promise]),
    AbortSignal.any([t.signal, failed.signal, AbortSignal.timeout(timeoutMs)]),
  );

  t.after(async () => {
    closing = true;
    const errors: unknown[] = [];
    const cleanup = async (run: Cleanup) => {
      try {
        await bounded(Promise.resolve().then(run), AbortSignal.timeout(cleanupTimeoutMs));
      } catch (error) { log?.('cleanup.error', error); errors.push(error); }
    };
    if (unsubscribe) await cleanup(unsubscribe);
    if (service) await cleanup(() => service!.close());
    if (polling) await cleanup(() => polling);
    if (runtime && store) {
      for (const session of store.listSessions()) {
        await cleanup(() => runtime!.kill(session));
      }
    }
    if (runtime) await cleanup(() => runtime!.close());
    if (store) await cleanup(() => store!.close());
    for (const run of ompCleanup) await cleanup(run);
    for (const run of telegramCleanup) await cleanup(run);
    for (const restore of restoreConsole) await cleanup(restore);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(
      errors,
      errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'),
    );
  });

  const omp = await setupOmpEnvironment({
    signal: t.signal,
    diagnostic: t.diagnostic.bind(t),
    after: ((run: Cleanup) => { ompCleanup.push(run); }) as TestContext['after'],
  }, options);
  log = omp.log;
  for (const method of ['log', 'error'] as const) {
    const original = console[method].bind(console);
    const mocked = t.mock.method(console, method, (...args: unknown[]) => {
      omp.log(`application.console.${method}`, args);
      original(omp.formatDiagnostic(args));
    });
    restoreConsole.push(() => mocked.mock.restore());
  }
  const telegram = await omp.step('telegram.provision', () => setupTelegramTest({
    signal: t.signal,
    after: ((run: Cleanup) => { telegramCleanup.push(run); }) as TestContext['after'],
  }));
  omp.registerSecret(telegram.bot.token);
  const config = emptyConfig(join(omp.dataDir, 'config.yaml'));
  config.dataDir = omp.dataDir;
  config.bots = [{ id: telegram.bot.id, token: telegram.bot.token }];
  config.instances = {
    [omp.workspace]: { chats: [{ botId: telegram.bot.id, chatId: telegram.forum.chatId }] },
  };
  config.omp = {
    executable: omp.executable,
    args: omp.args,
    relayUrl: omp.relayUrl,
    maxSessions: 2,
    startupTimeoutMs: 60_000,
  };
  writeConfig(config);
  store = new Store(':memory:');
  runtime = new OmpRuntime(config);
  const bot = new Bot(telegram.bot.token, { client: { environment: 'test' } });
  const hostFrames: HostFrame[] = [];
  const apiCalls: { method: string; payload: unknown; result: unknown }[] = [];
  let changed = Promise.withResolvers<void>();
  bot.api.config.use(async (previous, method, payload, signal) => {
    omp.log('telegram.api.request', { method, payload });
    try {
      const result = await previous(method, payload, signal);
      apiCalls.push({ method, payload, result });
      const notification = changed;
      changed = Promise.withResolvers<void>();
      notification.resolve();
      omp.log('telegram.api.result', { method, result });
      return result;
    } catch (error) {
      omp.log('telegram.api.error', { method, error });
      throw error;
    }
  });
  bot.use(async (ctx, next) => {
    omp.log('telegram.update', ctx.update);
    await next();
  });
  const connect: typeof connectCollab = async (binding, name, handlers, signal) => {
    try {
      const connection = await connectCollab(binding, name, {
        onFrame(frame) {
          hostFrames.push(frame);
          omp.log('collab.host.frame', frame);
          handlers.onFrame(frame);
          const notification = changed;
          changed = Promise.withResolvers<void>();
          notification.resolve();
        },
        onClose(reason) {
          omp.log('collab.close', { reason });
          handlers.onClose(reason);
        },
      }, signal);
      return {
        send(frame) {
          omp.log('collab.guest.frame', frame);
          try { connection.send(frame); } catch (error) {
            omp.log('collab.send.error', { error });
            throw error;
          }
        },
        close() { connection.close(); },
      };
    } catch (error) {
      omp.log('collab.connect.error', { error });
      throw error;
    }
  };
  const stickers = await bot.api.getForumTopicIconStickers();
  const [running, finished] = [...new Set(stickers.map(sticker => sticker.emoji).filter((emoji): emoji is string => Boolean(emoji)))];
  if (!running || !finished) throw new Error('Telegram test network must provide two distinct topic icon emojis');
  const topicActivityEmojis = { running, finished };
  omp.log('telegram.topic.icons', { topicActivityEmojis });
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  service = new BotService({ config, botConfig: config.bots[0]!, token: telegram.bot.token, store, runtime, bot, connect, topicActivityEmojis });

  const messages: Message[] = [];
  const receive = (message: Message) => {
    if (message.chat.id !== telegram.forum.chatId) return;
    messages.push(message);
    omp.log('telegram.user.message', message.raw);
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };
  telegram.user.client.onNewMessage.add(receive);
  telegram.user.client.onError.add(fail);
  unsubscribe = () => {
    telegram.user.client.onNewMessage.remove(receive);
    telegram.user.client.onError.remove(fail);
  };
  const ready = Promise.withResolvers<void>();
  polling = service.start(() => {
    try {
      service!.startBackground();
      ready.resolve();
    } catch (error) {
      fail(error);
      throw error;
    }
  });
  void polling.then(() => {
    if (!closing) fail(new Error('BotService polling ended before fixture teardown'));
  }, error => { if (!closing) fail(error); });
  await omp.step('application.start', () => operation(ready.promise));
  async function waitForCondition(predicate: () => boolean): Promise<void> {
    const signal = AbortSignal.any([t.signal, failed.signal, AbortSignal.timeout(operationTimeoutMs)]);
    for (;;) {
      signal.throwIfAborted();
      const notification = changed.promise;
      if (predicate()) return;
      await bounded(Promise.race([notification, failure.promise]), signal);
    }
  }

  async function waitForMessage(predicate: (message: Message) => boolean): Promise<Message> {
    let found: Message | undefined;
    await waitForCondition(() => {
      found = messages.find(predicate);
      return found !== undefined;
    });
    return found!;
  }

  return {
    telegram, omp, config, store, runtime, service, bot, hostFrames, apiCalls,
    send(text: string, threadId?: number): Promise<Message> {
      t.signal.throwIfAborted();
      failed.signal.throwIfAborted();
      return omp.step('telegram.user.send', async () => {
        omp.log('telegram.user.send.request', { text, threadId });
        const sent = await operation(telegram.user.client.sendText(
          telegram.forum.chat, text, threadId === undefined ? undefined : { threadId },
        ));
        omp.log('telegram.user.send.result', sent.raw);
        return sent;
      });
    },
    waitForCondition,
    waitForMessage,
    waitForReply(options: { replyToMessageId: number; threadId?: number }): Promise<Message> {
      return waitForMessage(message => message.sender.id === telegram.bot.id &&
        apiCalls.some(call => {
          if (call.method !== 'sendRichMessage') return false;
          const payload = call.payload as {
            chat_id: number;
            reply_parameters?: { message_id: number };
            message_thread_id?: number;
          };
          const response = call.result as { ok: boolean; result?: { message_id: number } };
          return payload.chat_id === telegram.forum.chatId &&
            payload.reply_parameters?.message_id === options.replyToMessageId &&
            (options.threadId === undefined || payload.message_thread_id === options.threadId) &&
            response.ok && response.result?.message_id === message.id;
        }));
    },
  };
}
