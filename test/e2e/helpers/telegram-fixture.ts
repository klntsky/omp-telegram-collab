import type { TestContext } from 'node:test';
import type { Api } from 'grammy';
import { TelegramTestUser } from './telegram-user.js';
import { createTelegramTestApi, createTelegramTestForum, type TelegramTestBot, type TelegramTestForum } from './telegram-resources.js';
import { TelegramTestInbox } from './telegram-updates.js';
import { combineTelegramErrors } from './errors.js';

export interface TelegramTestFixture {
  user: TelegramTestUser;
  bot: TelegramTestBot;
  api: Api;
  forum: TelegramTestForum;
  inbox: TelegramTestInbox;
}

export async function teardownTelegramTestResources(options: {
  user: Pick<TelegramTestUser, 'close' | 'releaseBot'>;
  forumSetup?: Promise<Pick<TelegramTestForum, 'close'>>;
  token?: string;
  canReleaseBot?: () => boolean;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    await (await options.forumSetup)?.close();
    if (options.token && (options.canReleaseBot?.() ?? true)) await options.user.releaseBot(options.token);
  } catch (error) { errors.push(error); }
  try { await options.user.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw combineTelegramErrors(...errors);
}

export async function setupTelegramTest(t: Pick<TestContext, 'after' | 'signal'>, options: {
  socket?: string;
  title?: string;
  canReleaseBot?: () => boolean;
} = {}): Promise<TelegramTestFixture> {
  const user = await TelegramTestUser.connect({ socket: options.socket, signal: t.signal });
  let forumSetup: Promise<TelegramTestForum> | undefined;
  let acquiredToken: string | undefined;
  t.after(() => teardownTelegramTestResources({ user, forumSetup, token: acquiredToken, canReleaseBot: options.canReleaseBot }));
  const token = await user.acquireBot();
  acquiredToken = token;
  const me = await createTelegramTestApi(token, user.signal).getMe();
  if (!me.username) throw new Error(`Telegram test bot ${me.id} has no username`);
  const bot: TelegramTestBot = { id: me.id, username: me.username, token };
  forumSetup = createTelegramTestForum(user, bot, { title: options.title });
  const forum = await forumSetup;
  const api = createTelegramTestApi(bot.token, user.signal);
  return { user, bot, api, forum, inbox: new TelegramTestInbox(api, user.signal) };
}
