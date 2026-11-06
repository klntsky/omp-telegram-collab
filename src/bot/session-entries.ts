import type { Context, Bot } from 'grammy';
import type { TopicSession, PromptContent, HostBinding } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import { contextDestination, replyTo, sendTo, forwardTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { GrammyError } from 'grammy';
export interface SessionEntryDependencies {
  options: BotOptions;
  bot: Bot<Context>;
  id: number;
  sessionAssigned(session: TopicSession): boolean;
  requireSessionAssignment(session: TopicSession): void;
  allMessagesArePrompts(chatId: number): boolean;
}

export class SessionEntries {
  constructor(private readonly dependencies: SessionEntryDependencies) {}
  async syncSessionEntries(): Promise<void> {
    for (const session of this.dependencies.options.store.listSessions(this.dependencies.id)) {
      if (!this.dependencies.sessionAssigned(session)) continue;
      const entry = this.dependencies.options.store.getSessionEntry(session.id);
      if (!entry) continue;
      const reply_markup = this.sessionMarkup(session);
      const markup = JSON.stringify(reply_markup);
      if (entry.markup === markup) continue;
      try {
        await this.dependencies.bot.api.editMessageReplyMarkup(session.chatId, entry.messageId, {reply_markup});
      } catch (error) {
        if (!(error instanceof GrammyError)) throw error;
        if (error.description === 'Bad Request: message to edit not found') {
          console.warn(`Pinned session entry no longer exists (${session.id}, ${entry.messageId}).`,error);
          this.dependencies.options.store.clearSessionEntry(session.id);
          continue;
        }
        if (!error.description.startsWith('Bad Request: message is not modified')) throw error;
        console.warn(`Pinned session entry already has the desired markup (${session.id}, ${entry.messageId}).`,error);
      }
      this.dependencies.options.store.setSessionEntry(session.id,entry.messageId,markup);
    }
  }
  sessionMarkup(session: TopicSession) {
    return {inline_keyboard: this.dependencies.options.config.publicUrl && this.dependencies.options.botConfig.miniAppShortName
      ? [[{text:'OPEN AGENT',url:this.link(session)}]] : []};
  }
  link(session: TopicSession): string {
    return `https://t.me/${this.dependencies.bot.botInfo!.username}/${this.dependencies.options.botConfig.miniAppShortName}?startapp=s_${session.id}`;
  }
  async announce(session: TopicSession): Promise<void> {
    this.dependencies.requireSessionAssignment(session);
    const text = this.dependencies.allMessagesArePrompts(session.chatId) ? 'Send a message to prompt the agent' : 'Use /p to submit a prompt';
    const message = await sendTo(this.dependencies.bot.api, topicDestination(session.chatId, session.threadId), text, {reply_markup:this.sessionMarkup(session)});
    this.dependencies.options.store.setSessionEntry(session.id,message.message_id,JSON.stringify(this.sessionMarkup(session)));
    this.dependencies.requireSessionAssignment(session);
    await this.dependencies.bot.api.pinChatMessage(session.chatId, message.message_id, { disable_notification: true });
  }
}
