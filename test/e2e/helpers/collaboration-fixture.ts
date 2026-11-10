import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { Message } from '@mtcute/node';
import type { GuestFrame, HostFrame } from '@oh-my-pi/pi-wire';
import { BotService } from '../../../src/bot.js';
import { emptyConfig, readConfig, writeConfig } from '../../../src/config.js';
import { OmpRuntime } from '../../../src/runtime.js';
import { Store } from '../../../src/store.js';
import type { FakeLlmProvider, FakeLlmScenario } from './fake-llm-provider.js';
import type { TelegramTestFixture } from './telegram-fixture.js';
import type { AppConfig, TopicSession } from '../../../shared/contracts.js';
import { setupOmpEnvironment } from './omp-environment.js';
import { setupTelegramTest } from './telegram-fixture.js';
import { bounded } from './async.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';
import { createCollaborationObserver } from './collaboration-observer.js';

const operationTimeoutMs = telegramTestTimeouts.request;
const cleanupTimeoutMs = telegramTestTimeouts.cleanup;

type Cleanup = () => unknown | Promise<unknown>;


export async function setupCollaborationTest(
  t: {
    signal: AbortSignal;
    diagnostic(message: string): void;
    after(cleanup: () => void | Promise<void>): void;
  },
  options: { scenarios: readonly FakeLlmScenario[] },
): Promise<CollaborationTest> {
  const telegramCleanup: Cleanup[] = [];
  const ompCleanup: Cleanup[] = [];
  let service: BotService | undefined;
  let runtime: OmpRuntime | undefined;
  let store: Store | undefined;
  let unsubscribe: Cleanup | undefined;
  let polling: Promise<void> | undefined;
  let activePollers = 0;
  let pollerStopFailed = false;
  let closing = false;
  let log: ((event: string, data: unknown) => void) | undefined;
  const restoreConsole: Cleanup[] = [];
  const failure = Promise.withResolvers<never>();
  const failed = new AbortController();
  const cleanupController = new AbortController();
  void failure.promise.catch(() => undefined);
  const fail = (error: unknown) => {
    log?.('application.error', error);
    failed.abort(error);
    failure.reject(error);
  };
  const operation = <T>(promise: Promise<T>, timeoutMs = operationTimeoutMs) => withTelegramTestDeadline(
    'collaboration request', timeoutMs, AbortSignal.any([t.signal, failed.signal]), async signal => {
      const cancel = () => {
        pollerStopFailed = true;
        void telegram.user.cancelSetup().catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try { return await bounded(Promise.race([promise, failure.promise]), signal); }
      finally { signal.removeEventListener('abort', cancel); }
    },
  );

  t.after(async () => {
    closing = true;
    const cleanupTimer = setTimeout(() => cleanupController.abort(new Error('Telegram test collaboration cleanup timed out after 15000ms')), cleanupTimeoutMs);
    const errors: unknown[] = [];
    const cleanup = async (run: Cleanup) => {
      try {
        const pending = Promise.resolve(run());
        void pending.catch(error => {
          if (cleanupController.signal.aborted) {
            log?.('cleanup.late.error', error);
            t.diagnostic(`Late cleanup failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          }
        });
        await bounded(pending, cleanupController.signal);
      } catch (error) { log?.('cleanup.error', error); errors.push(error); }
    };
    if (unsubscribe) await cleanup(unsubscribe);
    const errorsBeforeStop = errors.length;
    if (service) await cleanup(async () => {
      try { await service!.close(); } catch (error) { pollerStopFailed = true; throw error; }
    });
    if (polling) await cleanup(async () => {
      try { await polling; } catch (error) { pollerStopFailed = true; throw error; }
    });
    if (errors.length !== errorsBeforeStop) pollerStopFailed = true;
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
    clearTimeout(cleanupTimer);
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
  }, {...options, tools:['write', 'read', 'ask']});
  log = omp.log;
  void omp.provider.failure.catch(fail);
  for (const method of ['log', 'error'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      omp.log(`application.console.${method}`, args);
      original.call(console, omp.formatDiagnostic(args));
    };
    restoreConsole.push(() => { console[method] = original; });
  }
  const telegram = await omp.step('telegram.provision', () => setupTelegramTest({
    signal: t.signal,
    after: ((run: Cleanup) => { telegramCleanup.push(run); }) as TestContext['after'],
  }, { canReleaseBot: () => activePollers === 0 && !pollerStopFailed, step: omp.step, cleanupSignal: cleanupController.signal }));
  omp.registerSecret(telegram.bot.token);
  const config = emptyConfig(join(omp.dataDir, 'config.yaml'));
  config.dataDir = omp.dataDir;
  config.bots = [{ id: telegram.bot.id, token: telegram.bot.token }];
  config.instances = [{id: 1, defaultDir: omp.workspace, chats: [{ botId: telegram.bot.id, chatId: telegram.forum.chatId }]}];
  config.omp = {
    executable: omp.executable,
    args: omp.args,
    relayUrl: omp.relayUrl,
    maxSessions: 2,
    startupTimeoutMs: 60_000,
  };
  writeConfig(config);
  const databasePath = join(omp.dataDir, 'telegram.sqlite');
  store = new Store(databasePath);
  runtime = new OmpRuntime(config);
  const hostFrames: HostFrame[] = [];
  const guestFrames: GuestFrame[] = [];
  const updates: Update[] = [];
  const handledMessages = new Set<number>();
  const apiCalls: { method: string; payload: unknown; result: unknown }[] = [];
  let changed = Promise.withResolvers<void>();
  const { createBot: instrumentedBot, instrumentRuntime } = createCollaborationObserver({
    token: telegram.bot.token, chatId: telegram.forum.chatId, log: omp.log,
    apiCalls, updates, handledMessages, hostFrames, guestFrames,
    notify() {
      const notification = changed;
      changed = Promise.withResolvers<void>();
      notification.resolve();
    },
  });
  let bot = instrumentedBot();
  instrumentRuntime(runtime);
  const stickers = await telegram.api.getForumTopicIconStickers();
  const [running, finished] = [...new Set(stickers.map(sticker => sticker.emoji).filter((emoji): emoji is string => Boolean(emoji)))];
  if (!running || !finished) throw new Error('Telegram test network must provide two distinct topic icon emojis');
  const topicActivityEmojis = { running, finished };
  omp.log('telegram.topic.icons', { topicActivityEmojis });
  await telegram.api.deleteWebhook({ drop_pending_updates: true });
  service = new BotService({ config, botConfig: config.bots[0]!, token: telegram.bot.token, store, runtime, bot, topicActivityEmojis });

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
  async function startService(): Promise<void> {
    const ready = Promise.withResolvers<void>();
    const activeService = service!;
    activePollers++;
    polling = activeService.start(() => {
      try {
        activeService.startBackground();
        ready.resolve();
      } catch (error) {
        fail(error);
        throw error;
      }
    });
    void polling.then(() => {
      activePollers--;
      if (!closing) fail(new Error('BotService polling ended before fixture teardown'));
    }, error => { activePollers--; if (!closing) fail(error); });
    await withTelegramTestDeadline('application readiness', telegramTestTimeouts.readiness, t.signal,
      signal => bounded(Promise.race([ready.promise, failure.promise]), signal));
  }
  let lifecycle = Promise.resolve();
  function serializeLifecycle(run: () => Promise<void>): Promise<void> {
    const next = lifecycle.then(run);
    lifecycle = next.catch(() => undefined);
    return next;
  }
  async function pauseService(): Promise<void> {
    closing = true;
    if (service) {
      try { await operation(service.close()); }
      catch (error) { pollerStopFailed = true; throw error; }
      service = undefined;
    }
    if (polling) {
      try { await operation(polling); }
      catch (error) { pollerStopFailed = true; throw error; }
      polling = undefined;
    }
    if (runtime) {
      await operation(runtime.close());
      runtime = undefined;
    }
    if (store) {
      store.close();
      store = undefined;
    }
  }
  await omp.step('application.start', startService);
  async function waitForCondition(predicate: () => boolean): Promise<void> {
    await omp.step('workflow.expectation', () => withTelegramTestDeadline(
      'expectation', telegramTestTimeouts.expectation, AbortSignal.any([t.signal, failed.signal]), async signal => {
        const recheck = setInterval(() => {
          const notification = changed;
          changed = Promise.withResolvers<void>();
          notification.resolve();
        }, 100);
        try {
          for (;;) {
            signal.throwIfAborted();
            const notification = changed.promise;
            if (predicate()) return;
            await bounded(Promise.race([notification, failure.promise]), signal);
          }
        } finally {
          clearInterval(recheck);
        }
      },
    ));
  }

  async function waitForMessage(predicate: (message: Message) => boolean): Promise<Message> {
    let found: Message | undefined;
    await waitForCondition(() => {
      found = messages.find(predicate);
      return found !== undefined;
    });
    return found!;
  }

  function send(text: string, threadId?: number): Promise<Message> {
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
  }

  return {
    telegram, omp, config, hostFrames, guestFrames, apiCalls, updates, topicActivityEmojis,
    get runtime() { return runtime!; },
    get store() { return store!; },
    get service() { return service!; },
    get bot() { return bot; },
    pause(): Promise<void> {
      return serializeLifecycle(() => omp.step('application.pause', pauseService));
    },
    restart(): Promise<void> {
      return serializeLifecycle(() => omp.step('application.restart', async () => {
        await pauseService();
        Object.assign(config, readConfig(config.configPath));
        store = new Store(databasePath);
        runtime = new OmpRuntime(config);
        instrumentRuntime(runtime);
        bot = instrumentedBot();
        service = new BotService({ config, botConfig: config.bots[0]!, token: telegram.bot.token, store, runtime, bot, topicActivityEmojis });
        closing = false;
        await startService();
      }));
    },
    setFolderOptions(options: string[]): void {
      const updated = readConfig(config.configPath);
      const chat = updated.instances.find(instance => instance.id === 1)!.chats[0]!;
      chat.folder_options = options;
      writeConfig(updated);
      Object.assign(config.instances.find(instance => instance.id === 1)!.chats[0]!, chat);
    },
    send,
    async sendAndWait(text: string, threadId?: number): Promise<Message> {
      const sent = await send(text, threadId);
      await waitForCondition(() => handledMessages.has(sent.id));
      return sent;
    },
    waitForMessageHandled(messageId: number): Promise<void> {
      return waitForCondition(() => handledMessages.has(messageId));
    },
    waitForCondition,
    waitForMessage,
    async waitForReply(options: { replyToMessageId: number; threadId?: number }): Promise<Message> {
      let messageId: number | undefined;
      await waitForCondition(() => apiCalls.some(call => {
        if (call.method !== 'sendRichMessage') return false;
        const payload = call.payload as {
          chat_id: number;
          reply_parameters?: { message_id: number };
          message_thread_id?: number;
        };
        const response = call.result as { ok: boolean; result?: { message_id: number } };
        if (payload.chat_id !== telegram.forum.chatId ||
            payload.reply_parameters?.message_id !== options.replyToMessageId ||
            (options.threadId !== undefined && payload.message_thread_id !== options.threadId) ||
            !response.ok || response.result === undefined) return false;
        messageId = response.result.message_id;
        return true;
      }));
      const [message] = await operation(telegram.user.client.getMessages(telegram.forum.chatId, messageId!));
      if (!message) throw new Error(`Delivered Telegram reply ${messageId} is unavailable to the user client`);
      omp.log('telegram.user.reply', message.raw);
      return message;
    },
  };
}

export interface CollaborationTest {
  telegram: TelegramTestFixture;
  omp: {
    workspace: string;
    dataDir: string;
    executable: string;
    args: string[];
    relayUrl: string;
    interruptNextGuest(): void;
    provider: FakeLlmProvider;
    log(event: string, data: unknown): void;
    step<T>(name: string, action: () => Promise<T>): Promise<T>;
    git(cwd: string, ...args: string[]): Promise<string>;
    listHosts(): Promise<{ sessionId: string; cwd: string; pid: number }[]>;
    assertWorktree(session: TopicSession, branch?: string): Promise<void>;
    formatDiagnostic(args: unknown[]): string;
    logDirectory: string;
    registerSecret(value: string): void;
  };
  config: AppConfig;
  hostFrames: HostFrame[];
  guestFrames: GuestFrame[];
  apiCalls: { method: string; payload: unknown; result: unknown }[];
  updates: Update[];
  topicActivityEmojis: { running: string; finished: string };
  readonly runtime: OmpRuntime;
  readonly store: Store;
  readonly service: BotService;
  readonly bot: Bot;
  pause(): Promise<void>;
  restart(): Promise<void>;
  setFolderOptions(options: string[]): void;
  send(text: string, threadId?: number): Promise<Message>;
  sendAndWait(text: string, threadId?: number): Promise<Message>;
  waitForMessageHandled(messageId: number): Promise<void>;
  waitForCondition(predicate: () => boolean): Promise<void>;
  waitForMessage(predicate: (message: Message) => boolean): Promise<Message>;
  waitForReply(options: { replyToMessageId: number; threadId?: number }): Promise<Message>;
}
