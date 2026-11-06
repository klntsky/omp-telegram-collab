import { Bot, GrammyError, HttpError, type Context } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { AbortSignal as TelegramAbortSignal } from 'abort-controller';
import type { AppConfig, BotConfig, TopicSession, HostBinding } from '../shared/contracts.js';
import type { Store } from './store.js';
import type { Omp } from './omp.js';
import { refreshTermination } from './config.js';
import { topicDestination } from '../shared/topic-destination.js';
import { sendTo } from './telegram-destination.js';
import { installTelegramRetry } from './telegram-retry.js';
import type { SessionFeedHandlers, SessionFeedSubscription } from './session-feed.js';
import { createBotComponents, type BotComponents } from './bot/composition.js';

export interface BotOptions { config: AppConfig; botConfig: BotConfig; token: string; store: Store; runtime: Omp; bot?: Bot<Context>; configWritable?: () => boolean; topicActivityEmojis?: { running: string; finished: string } }

function retryDelay(ms: number, signal: TelegramAbortController['signal']): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
  return promise;
}

/** Public application boundary; operational state belongs to the composed domain owners. */
export class BotService {
  readonly bot: Bot<Context>;
  readonly config: BotConfig;
  readonly token: string;
  private readonly telegramRetry = new AbortController();
  private readonly apiAbort = new TelegramAbortController();
  private readonly sessionInvalidationHandlers = new Set<(sessionId: string, reason?: string) => void>();
  private readonly components: BotComponents;
  private stopped = false;
  private initialization?: Promise<void>;
  private termination?: Promise<void>;
  private polling?: { controller: TelegramAbortController; done: Promise<void> };

  constructor(private readonly options: BotOptions) {
    this.bot = options.bot ?? new Bot(options.token);
    installTelegramRetry(this.bot, this.telegramRetry.signal);
    this.config = options.botConfig;
    this.token = options.token;
    this.components = createBotComponents(options, this.bot, {
      id: () => this.id, stopped: () => this.stopped, apiAbort: this.apiAbort,
      applyTermination: () => this.applyTermination(),
      clearTermination: () => { this.termination = undefined; },
      invalidateSession: (id, reason) => { for (const handler of this.sessionInvalidationHandlers) handler(id, reason); },
    });
    this.bot.api.config.use((previous, method, payload, signal) => {
      if (
        method !== 'sendChatAction' &&
        /^(send|copyMessage|forwardMessage)/.test(method) &&
        'chat_id' in payload &&
        typeof payload.chat_id === 'number'
      ) {
        const threadId =
          'message_thread_id' in payload && typeof payload.message_thread_id === 'number'
            ? payload.message_thread_id
            : 1;
        this.components.connections.delivery.invalidateTyping(payload.chat_id, threadId);
      }
      return previous(method, payload, signal);
    });
    this.components.input.install();
  }

  get id(): number { return this.bot.isInited() ? this.bot.botInfo.id : 0; }

async applyTermination(): Promise<void> {
    if (!this.options.config.terminated) { this.termination = undefined; return; }
    this.termination ??= (async () => {
      this.components.admission.clear();
      const sessions = this.options.store.listSessions();
      for (const session of sessions) {
        this.options.store.cancelInitialTask(session.id);
        this.options.store.advanceSessionGeneration(session.id);
        for (const handler of this.sessionInvalidationHandlers) handler(session.id);
        this.components.connections.dropListener(session.id);
      }
      const results = await Promise.allSettled(sessions.map(session => this.options.runtime.kill(session)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
    })().catch(error => { this.termination = undefined; throw error; });
    await this.termination;
  }

async sendStatusNotice(chatId: number, text: string, signal?: TelegramAbortSignal): Promise<void> {
    const create = async () => {
      const topic = await this.bot.api.createForumTopic(chatId,'Bot status',{},signal);
      this.options.store.setBotStatusTopic(this.id,chatId,topic.message_thread_id);
      return topic.message_thread_id;
    };
    const threadId = this.options.store.getBotStatusTopic(this.id,chatId) ?? await create();
    try {
      await sendTo(this.bot.api,topicDestination(chatId,threadId),text,undefined,signal);
    } catch (error) {
      if (!(error instanceof GrammyError) || !/message thread not found|TOPIC_DELETED/i.test(error.description)) throw error;
      await sendTo(this.bot.api,topicDestination(chatId,await create()),text,undefined,signal);
    }
  }

initialize(): Promise<void> {
    return this.initialization ??= this.initializeOnce();
  }

  private async initializeOnce(): Promise<void> {
    if (!this.bot.isInited()) this.bot.botInfo = await this.bot.api.getMe(this.apiAbort.signal);
    this.options.store.recoverInitialTaskPreparations(this.id);
    await this.components.menus.syncCommandMenus();
    await this.components.entries.syncSessionEntries();
    if (refreshTermination(this.options.config)) await this.applyTermination();
  }

onSessionInvalidated(handler: (sessionId: string, reason?: string) => void): () => void {
    this.sessionInvalidationHandlers.add(handler);
    return () => { this.sessionInvalidationHandlers.delete(handler); };
  }

async ensureMirroring(session: TopicSession, binding: HostBinding, beforeMutation?: () => Promise<void>): Promise<void> {
    this.components.authorization.requireSessionAssignment(session);
    await this.components.connections.listen(session,binding,beforeMutation);
  }

async start(onReady?: () => void): Promise<void> {
    await this.initialize();
    if (this.stopped) return;
    if (!this.polling) {
      const controller = new TelegramAbortController();
      this.polling = { controller, done: this.poll(controller, onReady) };
    }
    await this.polling.done;
  }

  private async poll(controller: TelegramAbortController, onReady?: () => void): Promise<void> {
    let offset = 0;
    try {
      let webhookRemoved = false;
      while (!controller.signal.aborted) {
        try {
          if (!webhookRemoved) {
            await this.bot.api.deleteWebhook({ drop_pending_updates: false }, controller.signal);
            webhookRemoved = true;
          }
          const updates = await this.bot.api.getUpdates({
            offset, timeout: onReady ? 0 : 30, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'inline_query'],
          }, controller.signal);
          if (controller.signal.aborted) break;
          onReady?.();
          onReady = undefined;
          for (const update of updates) {
            if (controller.signal.aborted) break;
            await this.bot.handleUpdate(update);
            offset = update.update_id + 1;
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          const temporary = error instanceof GrammyError && (error.error_code === 429 || error.error_code >= 500);
          if (!temporary && !(error instanceof HttpError)) throw error;
          console.warn('Telegram polling failed; retrying.', error);
          const seconds = error instanceof GrammyError ? error.parameters.retry_after ?? 5 : 5;
          await retryDelay(Math.max(0, seconds) * 1000, controller.signal);
        }
      }
    } finally {
      if (controller.signal.aborted && offset > 0) {
        const acknowledgement = new TelegramAbortController();
        const timeout = setTimeout(() => acknowledgement.abort(), 5000);
        try {
          await this.bot.api.getUpdates({ offset, limit: 1, timeout: 0 }, acknowledgement.signal).catch(() => undefined);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  }

async close(): Promise<void> {
    this.telegramRetry.abort();
    this.stopped = true;
    const metadataCompletions = this.components.owners.disposeAll();
    this.components.maintenance.background.abort(new Error('Bot background maintenance stopped'));
    this.components.maintenance.catalogRefresh.abort(new Error('Bot catalog refresh stopped'));
    this.apiAbort.abort();
    this.components.connections.delivery.close();
    this.components.maintenance.stopTimers();
    this.components.input.closeAlbums();
    this.polling?.controller.abort();
    await this.polling?.done.catch(() => undefined);
    for (const timer of this.components.recovery.reconnects.values()) clearTimeout(timer);
    this.components.recovery.reconnects.clear();
    this.components.owners.closedSessions.clear();
    this.components.admission.clear();
    this.components.questions.endAll();
    const listeners = [...this.components.connections.listeners.values()];
    for (const item of listeners) {
      clearTimeout(item.initial?.timer);
      clearInterval(item.typingTimer);
      item.feed.close();
      item.connection?.close();
      for (const reader of item.readers) {
        reader.controller.abort(new Error('Session reader closed'));
        reader.feed.close();
        reader.connection?.close();
      }
      item.readers.clear();
    }
    this.components.connections.listeners.clear();
    await this.components.input.completion();
    await Promise.all(listeners.map((listener) => listener.tail));
    await Promise.all(listeners.map(listener => listener.history?.close()));
    await Promise.all(this.components.maintenance.backgroundTasks);
    await this.components.menus.completion();
    await Promise.all(metadataCompletions);
  }

async reconcileConfiguration(): Promise<void> {
    if (this.stopped) return;
    this.components.maintenance.catalogRefresh.abort(new Error('Bot configuration changed'));
    this.components.maintenance.catalogRefresh = new AbortController();
    this.components.maintenance.catalogTasks.clear();
    this.components.presets.resetCatalogRefresh();
    for (const session of this.options.store.listSessions(this.id)) {
      if (!this.components.authorization.sessionAssigned(session)) {
        this.components.owners.closedSessions.delete(session.id);
        this.components.owners.disposeMetadataOwner(session.id);
        this.components.capacity.invalidateSession(session.id);
        for (const handler of this.sessionInvalidationHandlers) handler(session.id);
        this.components.connections.dropListener(session.id);
      }
    }
    if (this.options.config.terminated) {
      await this.applyTermination();
      return;
    }
    this.termination = undefined;
    await this.components.menus.syncCommandMenus();
    await this.components.entries.syncSessionEntries();
    this.components.recovery.restoreSessions();
    void this.components.maintenance.refreshSkillCatalogs();
    void this.components.presets.refreshPresetCatalogs();
  }

async authorize(chatId: number, userId: number, statusOnly = false): Promise<void>{ return this.components.authorization.authorize(chatId, userId, statusOnly); }

async authorizeSession(session: TopicSession, userId: number, signal?: AbortSignal): Promise<boolean>{ return this.components.authorization.authorizeSession(session, userId, signal); }

async subscribeSessionFeed(session: TopicSession, handlers: SessionFeedHandlers): Promise<SessionFeedSubscription>{ return this.components.connections.subscribeSessionFeed(session, handlers); }

startBackground(): void{ return this.components.maintenance.startBackground(); }

refreshSkillCatalogs(): Promise<void>{ return this.components.maintenance.refreshSkillCatalogs(); }

async requestCapacity(session: TopicSession, limit: number): Promise<void>{ return this.components.capacity.requestCapacity(session, limit); }
}
