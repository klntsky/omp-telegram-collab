import { randomBytes } from 'node:crypto';
import TelegramAbortController from 'abort-controller';
import { Bot, type Api } from 'grammy';
import { Chat, Conversation, type Message, type tl } from '@mtcute/node';
import { installTelegramRetry } from '../../../src/telegram-retry.js';
import type { TelegramTestUser } from './telegram-user.js';
import { combineTelegramErrors } from './errors.js';

export interface TelegramTestBot {
  id: number;
  username: string;
  token: string;
}

export interface TelegramTestForum {
  chat: Chat;
  chatId: number;
  close(): Promise<void>;
}

export function createTelegramTestApi(token: string, signal: AbortSignal): Api {
  const bot = new Bot(token, { client: { environment: 'test', timeoutSeconds: 30 } });
  installTelegramRetry(bot, signal);
  bot.api.config.use(async (previous, method, payload, requestSignal) => {
    signal.throwIfAborted();
    const controller = new TelegramAbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    requestSignal?.addEventListener('abort', abort, { once: true });
    if (requestSignal?.aborted) controller.abort();
    try {
      return await previous(method, payload, controller.signal);
    } catch (error) {
      if (signal.aborted) throw combineTelegramErrors(signal.reason, error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      requestSignal?.removeEventListener('abort', abort);
    }
  });
  return bot.api;
}

export function uniqueTelegramTestName(): string {
  return `omp_e2e_${randomBytes(8).toString('hex')}`;
}

function unexpectedBotFather(message: Message): never {
  throw new Error(`Unexpected BotFather response:\n${message.text}`);
}

export async function createTelegramTestBot(user: TelegramTestUser, options: {
  name?: string;
  username?: string;
  timeoutMs?: number;
} = {}): Promise<TelegramTestBot> {
  const name = options.name ?? uniqueTelegramTestName();
  const username = options.username ?? `${uniqueTelegramTestName()}_bot`;
  if (!/^[a-z][a-z0-9_]{1,28}bot$/i.test(username) || username.length > 32) {
    throw new Error('Test bot username must contain 5–32 letters, digits, or underscores and end in bot');
  }
  const conversation = new Conversation(user.client, 'BotFather');
  const stop = () => conversation.stop();
  user.signal.throwIfAborted();
  user.signal.addEventListener('abort', stop, { once: true });
  try {
    return await conversation.with(async () => {
      const exchange = async (text: string) => {
        user.signal.throwIfAborted();
        const sent = await conversation.sendText(text, { abortSignal: user.signal });
        return conversation.waitForResponse(undefined, { message: sent.id, timeout: options.timeoutMs ?? 30000 });
      };
      await exchange('/cancel');
      const request = await exchange('/newbot');
      if (!/how are we going to call it|choose a name for your bot/i.test(request.text)) unexpectedBotFather(request);
      const named = await exchange(name);
      if (!/choose a username for your bot/i.test(named.text)) unexpectedBotFather(named);
      const created = await exchange(username);
      const token = created.text.match(/(?<![A-Za-z0-9_:-])[1-9]\d*:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/)?.[0];
      if (!token) unexpectedBotFather(created);
      const api = createTelegramTestApi(token, user.signal);
      const me = await api.getMe();
      if (me.username?.toLowerCase() !== username.toLowerCase()) throw new Error(`Created bot identity mismatch: expected @${username}, received @${me.username}`);
      return { id: me.id, username: me.username, token };
    });
  } finally {
    user.signal.removeEventListener('abort', stop);
  }
}

export async function createTelegramTestForum(user: TelegramTestUser, bot: TelegramTestBot, options: {
  title?: string;
} = {}): Promise<TelegramTestForum> {
  const updates = await user.call({
    _: 'channels.createChannel', title: options.title ?? uniqueTelegramTestName(),
    about: 'Disposable OMP Telegram end-to-end test forum', megagroup: true, forum: true,
  });
  if (updates._ !== 'updates' && updates._ !== 'updatesCombined') throw new Error(`Unexpected forum creation response: ${updates._}`);
  user.client.handleClientUpdate(updates);
  const raw = updates.chats.find((chat): chat is tl.RawChannel => chat._ === 'channel' && Boolean(chat.forum));
  if (!raw) throw new Error('Telegram did not return the created forum channel');
  const chat = new Chat(raw);
  const channel = await user.client.resolveChannel(chat);
  let closing: Promise<void> | undefined;
  const forum: TelegramTestForum = {
    chat, chatId: chat.id,
    close() {
      closing ??= user.call({ _: 'channels.deleteChannel', channel }, AbortSignal.timeout(30000)).then(result => {
        user.client.handleClientUpdate(result);
      });
      return closing;
    },
  };
  try {
    const resolved = await user.call({ _: 'contacts.resolveUsername', username: bot.username });
    const identity = resolved.users.find((value): value is tl.RawUser => value._ === 'user' && value.id === bot.id);
    if (!identity?.accessHash) throw new Error(`Telegram did not resolve test bot ${bot.id} with a usable access hash`);
    const botUser: tl.RawInputUser = { _: 'inputUser', userId: identity.id, accessHash: identity.accessHash };
    const invitation = await user.call({ _: 'channels.inviteToChannel', channel, users: [botUser] });
    user.client.handleClientUpdate(invitation.updates);
    if (invitation.missingInvitees.length) throw new Error(`Telegram could not invite test bot ${bot.id}: ${JSON.stringify(invitation.missingInvitees)}`);
    const promotion = await user.call({
      _: 'channels.editAdmin', channel, userId: botUser,
      adminRights: { _: 'chatAdminRights', manageTopics: true, pinMessages: true }, rank: 'Test bot',
    });
    user.client.handleClientUpdate(promotion);
    const member = await user.call({
      _: 'channels.getParticipant', channel,
      participant: { _: 'inputPeerUser', userId: identity.id, accessHash: identity.accessHash },
    });
    if (member.participant._ !== 'channelParticipantAdmin' || !member.participant.adminRights.manageTopics || !member.participant.adminRights.pinMessages) {
      throw new Error(`Test bot ${bot.id} lacks Manage Topics or Pin Messages in forum ${chat.id}`);
    }
    return forum;
  } catch (error) {
    try { await forum.close(); } catch (cleanupError) {
      throw combineTelegramErrors(error, cleanupError);
    }
    throw error;
  }
}
