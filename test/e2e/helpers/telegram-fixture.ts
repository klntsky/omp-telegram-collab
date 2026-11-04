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
  user: Pick<TelegramTestUser, 'close' | 'deleteBot'>;
  forumSetup?: Promise<Pick<TelegramTestForum, 'close'>>;
  token?: string;
  canDeleteBot?: () => boolean;
}): Promise<void> {
  const errors: unknown[] = [];
  try { await (await options.forumSetup)?.close(); } catch (error) { errors.push(error); }
  try {
    if (options.token) {
      if (!(options.canDeleteBot?.() ?? true)) throw new Error('Telegram bot poller did not stop; disposable bot retained in private recovery state');
      await options.user.deleteBot(options.token);
    }
  } catch (error) { errors.push(error); }
  try { await options.user.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw combineTelegramErrors(...errors);
}

export async function setupTelegramTest(t: Pick<TestContext, 'after' | 'signal'>, options: {
  title?: string;
  canDeleteBot?: () => boolean;
} = {}): Promise<TelegramTestFixture> {
  const user = await TelegramTestUser.connect({ signal: t.signal });
  let forumSetup: Promise<TelegramTestForum> | undefined;
  let createdToken: string | undefined;
  t.after(() => teardownTelegramTestResources({ user, forumSetup, token: createdToken, canDeleteBot: options.canDeleteBot }));
  const token = await user.createBot();
  createdToken = token;
  const me = await createTelegramTestApi(token, user.signal).getMe();
  if (!me.username) throw new Error(`Telegram test bot ${me.id} has no username`);
  const bot: TelegramTestBot = { id: me.id, username: me.username, token };
  forumSetup = createTelegramTestForum(user, bot, { title: options.title });
  const forum = await forumSetup;
  const api = createTelegramTestApi(bot.token, user.signal);
  return { user, bot, api, forum, inbox: new TelegramTestInbox(api, user.signal) };
}
