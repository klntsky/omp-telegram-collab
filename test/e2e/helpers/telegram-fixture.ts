import type { TestContext } from 'node:test';
import type { Api } from 'grammy';
import { TelegramTestUser } from './telegram-user.js';
import { createTelegramTestApi, createTelegramTestForum, type TelegramTestBot, type TelegramTestForum } from './telegram-resources.js';
import { TelegramTestInbox } from './telegram-updates.js';
import { combineTelegramErrors } from './errors.js';
import type { TelegramTestBotLease } from '../../../scripts/lib/telegram-test-bots.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';

export interface TelegramTestFixture {
  user: TelegramTestUser;
  bot: TelegramTestBot;
  api: Api;
  forum: TelegramTestForum;
  inbox: TelegramTestInbox;
}

export async function teardownTelegramTestResources(options: {
  user: Pick<TelegramTestUser, 'close'>;
  forumSetup?: Promise<Pick<TelegramTestForum, 'close'>>;
  lease?: Pick<TelegramTestBotLease, 'release'>;
  canReleaseBot?: () => boolean;
  signal?: AbortSignal;
  cancellation?: Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  let returned = false;
  let cleanupSignal = options.signal;
  const record = (error: unknown) => {
    errors.push(error);
    if (returned) console.error(error);
  };
  try {
    await withTelegramTestDeadline('fixture cleanup', telegramTestTimeouts.cleanup, options.signal ?? new AbortController().signal, async signal => {
      cleanupSignal = signal;
      let cancellationFailed = false;
      try { await options.cancellation; }
      catch (error) { cancellationFailed = true; record(error); }
      let forumSettled = !options.forumSetup;
      try {
        const forum = await options.forumSetup;
        forumSettled = true;
        await forum?.close(signal);
      } catch (error) { record(error); }
      try {
        if (options.lease) {
          signal.throwIfAborted();
          if (cancellationFailed || !forumSettled || !(options.canReleaseBot?.() ?? true)) throw new Error('Telegram bot poller did not stop; bot lease retained until process exit');
          await options.lease.release();
        }
      } catch (error) { record(error); }
    });
  } catch (error) {
    if (!errors.includes(error)) record(error);
  } finally {
    try {
      const closing = options.user.close();
      void closing.catch(record);
      await withTelegramTestDeadline('fixture user close', telegramTestTimeouts.cleanup,
        cleanupSignal ?? new AbortController().signal, () => closing);
    } catch (error) {
      if (!errors.includes(error)) record(error);
    }
    returned = true;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw combineTelegramErrors(...errors);
}

export async function setupTelegramTest(t: Pick<TestContext, 'after' | 'signal'>, options: {
  title?: string;
  canReleaseBot?: () => boolean;
  cleanupSignal?: AbortSignal;
  step?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
} = {}): Promise<TelegramTestFixture> {
  const step = options.step ?? (async <T>(_name: string, run: () => Promise<T>) => run());
  let user: TelegramTestUser | undefined;
  let forumSetup: Promise<TelegramTestForum> | undefined;
  let lease: TelegramTestBotLease | undefined;
  let provisionSettled = false;
  let cancellation: Promise<void> | undefined;
  t.after(async () => {
    if (!user) return;
    await teardownTelegramTestResources({ user, forumSetup, lease, signal: options.cleanupSignal, cancellation,
      canReleaseBot: () => provisionSettled && !cancellation && (options.canReleaseBot?.() ?? true) });
  });
  return withTelegramTestDeadline('provisioning', telegramTestTimeouts.provision, t.signal, async signal => {
    const cancel = () => { cancellation ??= user?.cancelSetup(); void cancellation?.catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      user = await step('telegram.user.authorize', () => TelegramTestUser.connect({ signal: t.signal, authorizationSignal: signal }));
      signal.throwIfAborted();
      lease = await step('telegram.bot.acquire', () => user!.acquireBot(signal));
      signal.throwIfAborted();
      const { token } = lease;
      const me = await step('telegram.bot.validate', () => createTelegramTestApi(token, signal).getMe());
      if (!me.username) throw new Error(`Telegram test bot ${me.id} has no username`);
      const bot: TelegramTestBot = { id: me.id, username: me.username, token };
      forumSetup = createTelegramTestForum(user, bot, { title: options.title, signal, step });
      const forum = await forumSetup;
      signal.throwIfAborted();
      const api = createTelegramTestApi(bot.token, user.signal);
      return { user, bot, api, forum, inbox: new TelegramTestInbox(api, user.signal) };
    } catch (error) {
      cancel();
      throw error;
    } finally {
      provisionSettled = true;
      signal.removeEventListener('abort', cancel);
    }
  });
}
