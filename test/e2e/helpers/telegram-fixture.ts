import type { TestContext } from 'node:test';
import type { Api } from 'grammy';
import { TelegramTestUser } from './telegram-user.js';
import { createTelegramTestApi, createTelegramTestForum, type TelegramTestBot, type TelegramTestForum } from './telegram-resources.js';
import { TelegramTestInbox } from './telegram-updates.js';
import { combineTelegramErrors } from './errors.js';
import type { TelegramTestBotLease } from '../../../scripts/lib/telegram-test-bots.js';

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
}): Promise<void> {
  const errors: unknown[] = [];
  try { await (await options.forumSetup)?.close(); } catch (error) { errors.push(error); }
  try {
    if (options.lease) {
      if (!(options.canReleaseBot?.() ?? true)) throw new Error('Telegram bot poller did not stop; bot lease retained until process exit');
      await options.lease.release();
    }
  } catch (error) { errors.push(error); }
  try { await options.user.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw combineTelegramErrors(...errors);
}

export async function setupTelegramTest(t: Pick<TestContext, 'after' | 'signal'>, options: {
  title?: string;
  canReleaseBot?: () => boolean;
} = {}): Promise<TelegramTestFixture> {
  const user = await TelegramTestUser.connect({ signal: t.signal });
  let forumSetup: Promise<TelegramTestForum> | undefined;
  let lease: TelegramTestBotLease | undefined;
  t.after(() => teardownTelegramTestResources({ user, forumSetup, lease, canReleaseBot: options.canReleaseBot }));
  lease = await user.acquireBot();
  const { token } = lease;
  const me = await createTelegramTestApi(token, user.signal).getMe();
  if (!me.username) throw new Error(`Telegram test bot ${me.id} has no username`);
  const bot: TelegramTestBot = { id: me.id, username: me.username, token };
  forumSetup = createTelegramTestForum(user, bot, { title: options.title });
  const forum = await forumSetup;
  const api = createTelegramTestApi(bot.token, user.signal);
  return { user, bot, api, forum, inbox: new TelegramTestInbox(api, user.signal) };
}
