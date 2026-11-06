import type { Context, Bot } from 'grammy';
import type { TopicSession, PromptContent, HostBinding } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import { contextDestination, replyTo, sendTo, forwardTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { GrammyError } from 'grammy';
import type { AbortSignal as TelegramAbortSignal } from 'abort-controller';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { findInstance } from '../config.js';
export interface SessionDetachDependencies {
  options: BotOptions;
  bot: Bot<Context>;
  id: number;
  readonly stopped: boolean;
  delivery: TelegramDelivery;
  apiAbort: {readonly signal: TelegramAbortSignal};
  clearClosedSession(sessionId: string): void;
  clearCapacityRequests(sessionId: string): void;
  clearPromptProposals(sessionId: string): void;
  invalidateSession(sessionId: string): void;
  dropListener(sessionId: string): void;
  iconCompletion(sessionId: string): Promise<void> | undefined;
  disposeMetadataOwner(sessionId: string): void;
}

export class SessionDetach {
  constructor(private readonly dependencies: SessionDetachDependencies) {}
  async detachSession(session: TopicSession): Promise<void> {
    this.dependencies.clearClosedSession(session.id);
    this.dependencies.clearCapacityRequests(session.id);
    this.dependencies.clearPromptProposals(session.id);
    this.dependencies.invalidateSession(session.id);
    this.dependencies.dropListener(session.id);
    await this.dependencies.iconCompletion(session.id);
    this.dependencies.disposeMetadataOwner(session.id);
    if (session.status === 'detached') return;
    try {
      await this.dependencies.delivery.run(
        session.chatId,
        () =>
          this.dependencies.bot.api.editForumTopic(
            session.chatId,
            session.threadId,
            { icon_custom_emoji_id: '' },
            this.dependencies.apiAbort.signal,
          ),
        () =>
          !this.dependencies.stopped &&
          this.dependencies.options.store.getTopicKind(session) === 'detached' &&
          findInstance(this.dependencies.options.config, this.dependencies.id, session.chatId)?.instance.id === session.instanceId,
      );
    } catch (error) {
      if (!(error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED')))
        throw error;
    }
  }
}
