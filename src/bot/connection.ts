import type { Bot, Context } from 'grammy';
import type { TopicSession, HostBinding, CollabConnection } from '../../shared/contracts.js';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, TopicActivity } from './types.js';
import { TelegramDelivery as Delivery } from '../telegram-delivery.js';
import { SessionFeed, type SessionFeedHandlers, type SessionFeedSubscription } from '../session-feed.js';
import { SessionHistory } from '../session-history.js';
import { ConversationConflictError, ConversationTransitionPendingError, SessionCapacityError } from '../runtime/types.js';
import { refreshTermination } from '../config.js';
import { ControlRoomUnavailableError } from '../runtime/registry.js';

export interface SessionConnectionsDependencies {
  applySessionTitle: (session: TopicSession) => Promise<void>;
  background: AbortSignal;
  bot: Bot<Context>;
  id: number;
  cancelReconnect: (id: string) => void;
  endListenerQuestions: (listener: Listener | undefined) => void;
  invalidateActivity: (id: string) => void;
  onFrame: (session: TopicSession, listener: Listener, frame: HostFrame, replay?: boolean) => void;
  refreshTyping: (session: TopicSession, listener: Listener) => void;
  requestCapacity: (session: TopicSession, limit: number) => Promise<void>;
  requireSessionAssignment: (session: TopicSession) => void;
  scheduleReconnect: (session: TopicSession, attempt?: number) => void;
  sessionAssigned: (session: TopicSession) => boolean;
  sessionObservation: (id: string) => SessionObservation;
  setTopicStatus: (session: TopicSession, status: TopicActivity, completed?: boolean) => void | Promise<void>;
  settlePrompt(session: TopicSession, submissionId: number, outcome: 'accepted' | 'startup-rejected' | 'uncertain'): void;
  stopped: () => boolean;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
}

export class SessionConnections {
  readonly listeners = new Map<string, Listener>();
  readonly delivery = new Delivery();
  constructor(private readonly deps: SessionConnectionsDependencies) {}
  async subscribeSessionFeed(session: TopicSession, handlers: SessionFeedHandlers): Promise<SessionFeedSubscription> {
    const binding = await this.deps.options.runtime.resolveExisting(session);
    if (!binding) throw new Error('Session closed');
    await this.listen(session, binding, undefined, true);
    const listener = this.listeners.get(session.id);
    if (!listener?.connection) throw new Error('Session closed');
    this.requireFeedListener(session, listener);
    if (session.runtime.kind === 'attached') return this.subscribeAttachedFeed(session, listener, handlers);
    await listener.history!.ensureFresh();
    this.requireFeedListener(session, listener);
    const subscription = listener.feed.subscribe(handlers);
    return {
      send: async frame => {
        this.requireFeedListener(session, listener);
        if (frame.t === 'history-page') {
          try { await listener.history!.ensureFresh(); }
          catch {
            this.requireFeedListener(session, listener);
            return;
          }
          this.requireFeedListener(session, listener);
        }
        subscription.send(frame);
      },
      close: () => subscription.close(),
    };
  }

  private requireFeedListener(session: TopicSession, listener: Listener): void {
    this.deps.requireSessionAssignment(session);
    if (this.deps.options.store.getSession(session.id)?.status !== 'open' ||
        this.listeners.get(session.id) !== listener ||
        listener.generation !== this.deps.options.store.getSessionGeneration(session.id)) throw new Error('Session closed');
  }

  private async subscribeAttachedFeed(session: TopicSession, listener: Listener, handlers: SessionFeedHandlers): Promise<SessionFeedSubscription> {
    const binding = await this.deps.options.runtime.resolveExisting(session);
    this.requireFeedListener(session, listener);
    if (!binding) throw new Error('Session closed');
    if (binding.sessionId !== listener.ompSessionId) {
      this.dropListener(session.id, 'Native conversation changed');
      this.deps.scheduleReconnect(session);
      throw new Error('The native conversation changed. Reopen the history view.');
    }
    const reader: {feed: SessionFeed; connection?: CollabConnection; controller: AbortController} = {
      controller: new AbortController(),
      feed: new SessionFeed(frame => {
        if (!reader.connection) throw new Error('Session not connected');
        reader.connection.send(frame);
      }),
    };
    listener.readers.add(reader);
    const close = () => {
      listener.readers.delete(reader);
      reader.controller.abort(new Error('Session reader closed'));
      reader.feed.close();
      reader.connection?.close();
    };
    try {
      const connection = await this.deps.options.runtime.connectCollab(binding, 'Mini App history reader', {
        onFrame: frame => reader.feed.accept(frame),
        onClose: reason => reader.feed.close(reason),
      }, AbortSignal.any([this.deps.background, reader.controller.signal]));
      reader.connection = connection;
      this.requireFeedListener(session, listener);
      const subscription = reader.feed.subscribe(handlers);
      return {send: frame => subscription.send(frame), close};
    } catch (error) {
      close();
      throw error;
    }
  }
  dropListener(id: string, reason = 'Host disconnected'): void {
    this.deps.invalidateActivity(id);
    this.deps.cancelReconnect(id);
    const listener = this.listeners.get(id);
    this.listeners.delete(id);
    const pendingSession = this.deps.options.store.getSession(id);
    for (const pending of listener?.pendingPrompts ?? []) {
      pending.observation.state = 'acceptance unknown';
      if (pendingSession) this.deps.settlePrompt(pendingSession, pending.submissionId, 'uncertain');
    }
    clearTimeout(listener?.typingTimer);
    const session = this.deps.options.store.getSession(id);
    if (session) this.delivery.invalidateTyping(session.chatId, session.threadId);
    this.deps.endListenerQuestions(listener);
    listener?.feed.close(reason);
    if (listener) {
      for (const reader of listener.readers) {
        reader.controller.abort(new Error(reason));
        reader.feed.close(reason);
        reader.connection?.close();
      }
      listener.readers.clear();
      if (listener.history) void listener.history.close().catch(error => console.error('Could not close session history', error));
    }
    listener?.connection?.close();
  }
  listen(
    session: TopicSession,
    binding?: HostBinding,
    beforeMutation?: () => Promise<void>,
    existingOnly = false,
    recoverClosed = true,
  ): Promise<CollabConnection> {
    if (existingOnly && !binding)
      return Promise.reject(new Error('Existing host binding is required'));
    this.deps.requireSessionAssignment(session);
    if (this.deps.options.store.getSession(session.id)?.status !== 'open')
      return Promise.reject(new Error('This topic is closed. Reopen it before connecting.'));
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const existing = this.listeners.get(session.id);
    if (existing?.promise && existing.generation === generation) {
      return existing.promise.then(() => binding ?? this.deps.options.runtime.resolveExisting(session)).then(current => {
        this.deps.requireSessionAssignment(session);
        if (current && this.deps.options.store.getSession(session.id)?.cwd !== session.cwd)
          this.deps.options.store.setSessionCwd(session.id, session.cwd);
        if (this.listeners.get(session.id) === existing && current &&
            existing.ompSessionId === current.sessionId) return existing.promise!;
        if (this.listeners.get(session.id) === existing && current && existing.ompSessionId !== current.sessionId)
          this.deps.options.store.setPendingSessionTitle(session.id, undefined);
        if (this.listeners.get(session.id) === existing) this.dropListener(session.id, 'Native conversation changed');
        return this.listen(session, this.listeners.has(session.id) ? undefined : current, beforeMutation, existingOnly, recoverClosed);
      }).catch(error => {
        if (this.listeners.get(session.id) === existing) {
          this.dropListener(session.id, 'Could not verify native conversation');
          if (!(error instanceof ConversationConflictError)) this.deps.scheduleReconnect(session);
        }
        throw error;
      });
    }
    if (existing) this.dropListener(session.id);
    const listener: Listener = {
      sessionId: session.id,
      generation,
      feed: new SessionFeed(frame => {
        if (!listener.connection) throw new Error('Session not connected');
        listener.connection.send(frame);
      }),
      tail: Promise.resolve(),
      readers: new Set(),
      queued: 0,
      recovering: this.deps.options.store.hasSnapshot(session.id),
      receiptBoundary: 0,
      snapshotReplyTarget: this.deps.options.store.getReplyTarget(session.id),
      pendingPrompts: [],
      pendingAnswers: new Map(),
      pendingStops: [],
      queuedMessages: 0,
    };
    this.listeners.set(session.id, listener);
    this.deps.refreshTyping(session, listener);
    void this.deps.setTopicStatus(
      session,
      this.deps.options.store.promptQueue.has(session.id) ? 'running' : 'unknown',
    );
    const active = () =>
      !this.deps.stopped() &&
      !this.deps.options.config.terminated &&
      this.deps.sessionAssigned(session) &&
      this.deps.options.store.getSession(session.id)?.status === 'open' &&
      this.deps.options.store.getSessionGeneration(session.id) === generation &&
      this.listeners.get(session.id) === listener;
    const closed = new Error('Session closed');
    listener.promise = (
      binding ? Promise.resolve(binding) : this.deps.options.runtime.ensure(session, beforeMutation)
    )
      .then(async (binding) => {
        if (!active()) throw closed;
        if (this.deps.options.store.getSession(session.id)?.cwd !== session.cwd)
          this.deps.options.store.setSessionCwd(session.id, session.cwd);
        await beforeMutation?.();
        if (!active()) throw closed;
        await this.deps.applySessionTitle(session);
        if (!active()) throw closed;
        listener.ompSessionId = binding.sessionId;
        if (session.runtime.kind === 'managed') {
          listener.history = new SessionHistory(listener.feed, {
            sessionId: binding.sessionId,
            source: () => this.deps.options.runtime.historySource(session),
            watch: (source, options) => this.deps.options.runtime.watchHistory(source, options),
            assertActive: () => this.requireFeedListener(session, listener),
            onError: error => {
              this.deps.sessionObservation(session.id).failure = {operation: 'Session history refresh', at: Date.now(), error};
              console.error('Could not refresh session history', error);
            },
          });
          await listener.history.prepare();
          if (!active()) throw closed;
        }
        return this.deps.options.runtime.connectCollab(
          binding,
          `Telegram @${this.deps.bot.botInfo!.username}`,
          {
            onFrame: (frame) => { if (active()) this.deps.onFrame(session, listener, frame); },
            onClose: (reason) => {
              if (!active()) return;
              console.warn(JSON.stringify({
                event: 'omp-mirror-disconnected',
                at: new Date().toISOString(),
                botId: this.deps.id,
                sessionId: session.id,
                chatId: session.chatId,
                threadId: session.threadId,
                instanceId: binding.instanceId,
                hostGeneration: binding.generation,
                ompSessionId: binding.sessionId,
                generation,
                connected: listener.connection !== undefined,
                reason,
              }));
              this.deps.sessionObservation(session.id).failure = {
                operation: 'Mirroring disconnected',
                at: Date.now(),
                error: reason,
              };
              const connected = listener.connection !== undefined;
              this.dropListener(session.id, reason);
              if (connected) this.deps.scheduleReconnect(session);
            },
          },
          this.deps.background,
        );
      })
      .then(async (connection) => {
        if (!active()) {
          connection.close();
          throw closed;
        }
        this.deps.sessionObservation(session.id).mirrored = true;
        listener.connection = connection;
        await listener.history?.start(connection);
        if (!active()) { connection.close(); throw closed; }
        return connection;
      })
      .catch(async (error) => {
        if (active())
          this.deps.sessionObservation(session.id).failure = {
            operation: 'Session connection',
            at: Date.now(),
            error,
          };
        try {
          if (!existingOnly && error instanceof SessionCapacityError && active())
            await this.deps.requestCapacity(session, error.limit);
          if (
            error !== closed ||
            !recoverClosed ||
            existingOnly ||
            this.deps.stopped() ||
            refreshTermination(this.deps.options.config) ||
            !this.deps.sessionAssigned(session) ||
            this.deps.options.store.getSession(session.id)?.status !== 'open' ||
            this.deps.options.store.getSessionGeneration(session.id) !== generation
          )
            throw error;
        } finally {
          const reconnect = !existingOnly && active() &&
            (error instanceof ControlRoomUnavailableError || error instanceof ConversationTransitionPendingError ||
              (listener.ompSessionId !== undefined && error !== closed && !(error instanceof ConversationConflictError)));
          if (this.listeners.get(session.id) === listener)
            this.dropListener(session.id, error instanceof Error ? error.message : String(error));
          if (reconnect) this.deps.scheduleReconnect(session);
        }
        return this.listen(session, undefined, beforeMutation, false, false);
      });
    return listener.promise;
  }
}
