import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import TelegramAbortController from 'abort-controller';
import { Bot, type Api } from 'grammy';
import { Chat, tl } from '@mtcute/node';
import type { TelegramTestUser } from './telegram-user.js';
import { combineTelegramErrors } from './errors.js';
import { bounded } from './async.js';
import { telegramTestDeadlineRemaining, telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';

export interface TelegramTestBot {
  id: number;
  username: string;
  token: string;
}

export interface TelegramTestForum {
  chat: Chat;
  chatId: number;
  close(signal?: AbortSignal): Promise<void>;
}

export function createTelegramTestApi(token: string, signal: AbortSignal): Api {
  const bot = new Bot(token, { client: { environment: 'test', timeoutSeconds: 30 } });
  bot.api.config.use(async (previous, method, payload, requestSignal) => {
    return withTelegramTestDeadline(`telegram.api.${method}`, telegramTestTimeouts.request, signal, async scope => {
      const controller = new TelegramAbortController();
      const retryStop = new AbortController();
      const abort = () => { controller.abort(); retryStop.abort(); };
      scope.addEventListener('abort', abort, { once: true });
      requestSignal?.addEventListener('abort', abort, { once: true });
      if (scope.aborted || requestSignal?.aborted) controller.abort();
      try {
        let response = await previous(method, payload, controller.signal);
        while (!response.ok && response.error_code === 429) {
          const seconds = response.parameters?.retry_after;
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 ||
              scope.aborted || requestSignal?.aborted || seconds * 1000 >= telegramTestDeadlineRemaining(scope)) return response;
          try {
            await delay(seconds * 1000, undefined, { signal: retryStop.signal });
          } catch (error) {
            if (scope.aborted || requestSignal?.aborted) return response;
            throw error;
          }
          if (scope.aborted || requestSignal?.aborted) return response;
          response = await previous(method, payload, controller.signal);
        }
        return response;
      } catch (error) {
        if (scope.aborted) throw combineTelegramErrors(scope.reason, error);
        throw error;
      } finally {
        scope.removeEventListener('abort', abort);
        requestSignal?.removeEventListener('abort', abort);
      }
    });
  });
  return bot.api;
}

export function uniqueTelegramTestName(): string {
  return `omp_e2e_${randomBytes(8).toString('hex')}`;
}


export async function createTelegramTestForum(user: TelegramTestUser, bot: TelegramTestBot, options: {
  title?: string;
  signal?: AbortSignal;
  step?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
} = {}): Promise<TelegramTestForum> {
  const signal = options.signal ?? user.signal;
  const step = options.step ?? (<T>(_name: string, run: () => Promise<T>) => run());
  const title = options.title ?? uniqueTelegramTestName();
  const startedAt = Math.floor(Date.now() / 1000);
  let chat: Chat | undefined;
  for (let attempt = 0; !chat; attempt++) {
    signal.throwIfAborted();
    try {
      const updates = await step('telegram.forum.create', () => user.call({
        _: 'channels.createChannel', title,
        about: 'Disposable OMP Telegram end-to-end test forum', megagroup: true, forum: true,
      }, signal));
      if (updates._ !== 'updates' && updates._ !== 'updatesCombined') throw new Error(`Unexpected forum creation response: ${updates._}`);
      user.client.handleClientUpdate(updates);
      const raw = updates.chats.find((value): value is tl.RawChannel => value._ === 'channel' && Boolean(value.forum));
      if (!raw) throw new Error('Telegram did not return the created forum channel');
      chat = new Chat(raw);
    } catch (error) {
      if (!tl.RpcError.is(error, 'CHAT_OCCUPY_LOC_FAILED') || error.code !== 500) throw error;
      try {
        const dialogs = user.client.iterDialogs({ archived: 'keep' });
        for (;;) {
          const next = await bounded(dialogs.next(), signal);
          if (next.done) break;
          signal.throwIfAborted();
          const peer = next.value.peer;
          if (peer instanceof Chat && peer.title === title && peer.raw._ === 'channel' &&
            peer.raw.creator && peer.raw.forum && peer.raw.date >= startedAt) {
            if (chat) throw new Error(`Telegram returned multiple newly created forums named ${title}`);
            chat = peer;
          }
        }
      } catch (inspectionError) {
        throw combineTelegramErrors(error, inspectionError);
      }
      if (!chat) {
        if (attempt >= 2) throw error;
        await delay((attempt + 1) * 1000, undefined, { signal });
      }
    }
  }
  const channel = await bounded(user.client.resolveChannel(chat), signal);
  let closing: Promise<void> | undefined;
  const forum: TelegramTestForum = {
    chat, chatId: chat.id,
    close(cleanupSignal = AbortSignal.timeout(telegramTestTimeouts.cleanup)) {
      closing ??= user.call({ _: 'channels.deleteChannel', channel }, cleanupSignal).then(result => {
        user.client.handleClientUpdate(result);
      });
      return closing;
    },
  };
  try {
    return await step('telegram.forum.configure', async () => {
      const resolved = await user.call({ _: 'contacts.resolveUsername', username: bot.username }, signal);
      const identity = resolved.users.find((value): value is tl.RawUser => value._ === 'user' && value.id === bot.id);
      if (!identity?.accessHash) throw new Error(`Telegram did not resolve test bot ${bot.id} with a usable access hash`);
      const botUser: tl.RawInputUser = { _: 'inputUser', userId: identity.id, accessHash: identity.accessHash };
      const invitation = await user.call({ _: 'channels.inviteToChannel', channel, users: [botUser] }, signal);
      user.client.handleClientUpdate(invitation.updates);
      if (invitation.missingInvitees.length) throw new Error(`Telegram could not invite test bot ${bot.id}: ${JSON.stringify(invitation.missingInvitees)}`);
      const promotion = await user.call({
        _: 'channels.editAdmin', channel, userId: botUser,
        adminRights: { _: 'chatAdminRights', manageTopics: true, pinMessages: true }, rank: 'Test bot',
      }, signal);
      user.client.handleClientUpdate(promotion);
      const member = await user.call({
        _: 'channels.getParticipant', channel,
        participant: { _: 'inputPeerUser', userId: identity.id, accessHash: identity.accessHash },
      }, signal);
      if (member.participant._ !== 'channelParticipantAdmin' || !member.participant.adminRights.manageTopics || !member.participant.adminRights.pinMessages) {
        throw new Error(`Test bot ${bot.id} lacks Manage Topics or Pin Messages in forum ${chat.id}`);
      }
      return forum;
    });
  } catch (error) {
    try { await forum.close(); } catch (cleanupError) {
      throw combineTelegramErrors(error, cleanupError);
    }
    throw error;
  }
}
