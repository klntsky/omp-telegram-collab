import { logEvent } from '../logging.js';
import type { Bot, Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { Listener, TopicActivity } from './types.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { findInstance } from '../config.js';

export interface TypingIndicatorsDependencies {
  activityAtUse: (session: TopicSession) => TopicActivity;
  bot: Bot<Context>;
  delivery: TelegramDelivery;
  id: number;
  getListener: (id: string) => Listener | undefined;
  sessionAssigned: (session: TopicSession) => boolean;
  stopped: () => boolean;
  options: Pick<BotOptions, 'config' | 'store'>;
}

export class TypingIndicators {
  constructor(private readonly deps: TypingIndicatorsDependencies) {}
  typingActive(session: TopicSession, listener: Listener): boolean {
    if (this.deps.options.store.getSessionGeneration(session.id) !== listener.generation) return false;
    if (
      this.deps.stopped() ||
      this.deps.options.config.terminated ||
      this.deps.getListener(session.id) !== listener ||
      !this.deps.sessionAssigned(session) ||
      this.deps.options.store.getSession(session.id)?.status !== 'open'
    )
      return false;
    const mode =
      findInstance(this.deps.options.config, this.deps.id, session.chatId)?.instance.chats.find(
        (chat) => chat.botId === this.deps.id && chat.chatId === session.chatId,
      )?.typing_indicators ?? 'disabled';
    return mode === 'inference'
      ? this.deps.activityAtUse(session) === 'running'
      : mode === 'streaming' && listener.typingText === true;
  }

  refreshTyping(session: TopicSession, listener: Listener): void {
    if (this.deps.stopped() || this.deps.getListener(session.id) !== listener) return;
    const active = this.typingActive(session, listener);
    const delay = active ? Math.max(0, (listener.typingNextAt ?? 0) - Date.now()) : 4000;
    if (!listener.typingTimer) {
      listener.typingTimer = setTimeout(() => {
        listener.typingTimer = undefined;
        this.refreshTyping(session, listener);
      }, delay || 4000);
      listener.typingTimer.unref();
    }
    if (!active) {
      this.deps.delivery.invalidateTyping(session.chatId, session.threadId);
      return;
    }
    if ((listener.typingNextAt ?? 0) > Date.now()) return;
    listener.typingNextAt = Date.now() + 4000;
    void this.deps.delivery
      .typing(
        session.chatId,
        session.threadId,
        () =>
          this.deps.bot.api.sendChatAction(session.chatId, 'typing', {
            message_thread_id: session.threadId === 1 ? undefined : session.threadId,
          }),
        () => this.typingActive(session, listener),
      )
      .catch((error) => {
        logEvent('warn', 'could-not-send-typing-action', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not send typing action (${session.id}).`, error});
      });
  }
}
