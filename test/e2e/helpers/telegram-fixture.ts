import type { TestContext } from 'node:test';
import type { Api } from 'grammy';
import { TelegramTestUser, readTelegramTestCredentials, type TelegramTestCredentials } from './telegram-user.js';
import { createTelegramTestApi, createTelegramTestBot, createTelegramTestForum, type TelegramTestBot, type TelegramTestForum } from './telegram-resources.js';
import { TelegramTestInbox } from './telegram-updates.js';
import { combineTelegramErrors } from './errors.js';

export interface TelegramTestFixture {
  user: TelegramTestUser;
  bot: TelegramTestBot;
  api: Api;
  forum: TelegramTestForum;
  inbox: TelegramTestInbox;
}

export async function setupTelegramTest(t: Pick<TestContext, 'after' | 'signal'>, options: {
  credentials?: TelegramTestCredentials;
  botToken?: string;
  title?: string;
} = {}): Promise<TelegramTestFixture> {
  const user = await TelegramTestUser.login(options.credentials ?? readTelegramTestCredentials(), { signal: t.signal });
  let forumSetup: Promise<TelegramTestForum> | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    try { await (await forumSetup)?.close(); } catch (error) { errors.push(error); }
    try { await user.close(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw combineTelegramErrors(...errors);
  });
  const token = options.botToken ?? process.env.TELEGRAM_TEST_BOT_TOKEN;
  let bot: TelegramTestBot;
  if (token) {
    const me = await createTelegramTestApi(token, user.signal).getMe();
    if (!me.username) throw new Error(`Telegram test bot ${me.id} has no username`);
    bot = { id: me.id, username: me.username, token };
  } else {
    bot = await createTelegramTestBot(user);
  }
  forumSetup = createTelegramTestForum(user, bot, { title: options.title });
  const forum = await forumSetup;
  const api = createTelegramTestApi(bot.token, user.signal);
  return { user, bot, api, forum, inbox: new TelegramTestInbox(api, user.signal) };
}
