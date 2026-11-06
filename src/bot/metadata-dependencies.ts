import type { Bot, Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import type { Listener, SessionObservation } from './types.js';

export interface MetadataDependencies {
  options: BotOptions;
  bot: Bot<Context>;
  delivery: TelegramDelivery;
  background: AbortController;
  isStopped(): boolean;
  sessionAssigned(session: TopicSession): boolean;
  sessionObservation(id: string): SessionObservation;
}
export interface ActivityDependencies {
  getListener(id: string): Listener | undefined;
  dropListener(id: string): void;
  clearSessionRequests(id: string): void;
  offerWorktreeCleanup(session: TopicSession, generation: number): Promise<void>;
  runBackground(label: string, operation: () => Promise<void>): Promise<void>;
}
