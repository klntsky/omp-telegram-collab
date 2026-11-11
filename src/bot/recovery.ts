import { logEvent } from '../logging.js';
import type { Bot, Context } from 'grammy';
import type { TopicSession, HostBinding, CollabConnection } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, SessionMetadataOwner } from './types.js';
import { SessionCapacityError } from '../runtime/types.js';
import { withCancellation } from '../cancellation.js';
import { sendTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';

export interface MirrorRecoveryDependencies {
  background: AbortSignal;
  bot: Bot<Context>;
  dropListener: (id: string, reason?: string) => void;
  id: number;
  getListener: (id: string) => Listener | undefined;
  currentMetadataOwner: (id: string) => SessionMetadataOwner | undefined;
  listen: (session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>, existingOnly?: boolean, recoverClosed?: boolean) => Promise<CollabConnection>;
  metadataOwner: (session: TopicSession) => SessionMetadataOwner;
  refreshTopicStatus: (session: TopicSession) => Promise<void>;
  runBackground: (phase: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  sendInitial: (session: TopicSession) => Promise<void>;
  sessionAssigned: (session: TopicSession) => boolean;
  stopped: () => boolean;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
}

export class MirrorRecovery {
  readonly reconnects = new Map<string, NodeJS.Timeout>();
  readonly restoring = new Set<string>();
  readonly reconnecting = new Set<string>();
  private readonly sessionObservations = new Map<string, SessionObservation>();
  sessionObservation(id: string): SessionObservation {
    let observation = this.sessionObservations.get(id);
    if (!observation) {
      observation = {};
      this.sessionObservations.set(id,observation);
    }
    return observation;
  }
  cancelReconnect(id: string): void { clearTimeout(this.reconnects.get(id)); this.reconnects.delete(id); }
  constructor(private readonly deps: MirrorRecoveryDependencies) {}
  restoreSessions(): void {
    const sessions = this.deps.options.store
      .listSessions(this.deps.id)
      .filter(
        (existing) =>
          !this.deps.options.config.terminated &&
          this.deps.sessionAssigned(existing) &&
          !(this.deps.getListener(existing.id) !== undefined) &&
          !this.restoring.has(existing.id),
      );
    for (const session of sessions) this.restoring.add(session.id);
    void Promise.all(
      Array.from({ length: Math.min(4, sessions.length) }, async () => {
        for (let next = sessions.shift(); next; next = sessions.shift()) {
          const existing = next;
          const generation = this.deps.options.store.getSessionGeneration(existing.id);
          await this.deps.runBackground(`restore:${existing.id}`, async (signal) => {
            try {
              if (existing.status === 'open') {
                if (this.deps.options.store.hasPendingInitialTask(existing.id)) {
                  await withCancellation(this.deps.sendInitial(existing), signal);
                } else {
                  await this.recoverExistingMirror(existing, signal);
                }
              }
              await withCancellation(this.deps.refreshTopicStatus(existing), signal);
            } catch (error) {
              if (error === signal.reason) throw error;
              if (
                !this.deps.stopped() &&
                !(error instanceof SessionCapacityError) &&
                this.deps.options.store.getSessionGeneration(existing.id) === generation
              )
                this.scheduleReconnect(existing);
              throw error;
            }
          }).finally(() => this.restoring.delete(existing.id));
        }
      }),
    );
  }
  recoverExistingMirror(
    session: TopicSession,
    signal = this.deps.background,
  ): Promise<void> {
    if (this.deps.stopped() || this.deps.options.config.terminated || signal.aborted) return Promise.resolve();
    const metadataOwner = this.deps.metadataOwner(session);
    const existing = metadataOwner.recovery;
    if (existing) return existing;
    const generation = metadataOwner.generation;
    const owner = metadataOwner.activity;
    const active = () =>
      !this.deps.stopped() &&
      !this.deps.options.config.terminated &&
      this.deps.sessionAssigned(session) &&
      this.deps.options.store.getSession(session.id)?.status === 'open' &&
      this.deps.options.store.getSessionGeneration(session.id) === generation &&
      this.deps.currentMetadataOwner(session.id)?.activity === owner;
    if (
      !active() ||
      (this.deps.getListener(session.id) !== undefined) ||
      this.deps.options.store.hasPendingInitialTask(session.id)
    )
      return Promise.resolve();
    const deadline = AbortSignal.any([
      signal,
      metadataOwner.controller.signal,
      AbortSignal.timeout(5000),
    ]);
    const recovery = (async () => {
      const binding = await withCancellation(
        this.deps.options.runtime.resolveExisting(session),
        deadline,
      );
      if (!binding || !active() || (this.deps.getListener(session.id) !== undefined)) return;
      const connecting = this.deps.listen(session, binding, undefined, true);
      const listener = this.deps.getListener(session.id);
      try {
        await withCancellation(connecting, deadline);
      } catch (error) {
        if (this.deps.getListener(session.id) === listener) this.deps.dropListener(session.id);
        throw error;
      }
    })().finally(() => {
      if (metadataOwner.recovery === recovery) metadataOwner.recovery = undefined;
    });
    metadataOwner.recovery = recovery;
    return recovery;
  }
  scheduleReconnect(session: TopicSession, attempt = 0): void {
    if (this.deps.stopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session)) return;
    const current = this.deps.options.store.getSession(session.id);
    if (current?.status !== 'open' || this.reconnects.has(session.id)) return;
    if (attempt >= 5) {
      logEvent('warn', 'omp-mirror-reconnect-exhausted', {
        at: new Date().toISOString(),
        botId: this.deps.id,
        sessionId: session.id,
        chatId: session.chatId,
        threadId: session.threadId,
        attempts: attempt,
        generation: this.deps.options.store.getSessionGeneration(session.id),
      });
      void sendTo(
        this.deps.bot.api,
        topicDestination(session.chatId, session.threadId),
        'Session mirroring disconnected.',
      ).catch(error => logEvent('warn', 'could-not-deliver-mirroring-disconnected-notice', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not deliver mirroring disconnected notice (${session.id}).`, error}));
      return;
    }
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const timer = setTimeout(
      () => {
        this.reconnects.delete(session.id);
        if (
          this.deps.stopped() ||
          !this.deps.sessionAssigned(session) ||
          this.deps.options.store.getSessionGeneration(session.id) !== generation
        )
          return;
        const active = this.deps.options.store.getSession(session.id);
        if (active?.status !== 'open') return;
        this.reconnecting.add(active.id);
        void this.deps.runBackground(`reconnect:${active.id}`, async (signal) => {
          try {
            if (this.deps.options.store.hasPendingInitialTask(active.id)) {
              await withCancellation(this.deps.sendInitial(active), signal);
            } else {
              await this.recoverExistingMirror(active, signal);
            }
            await withCancellation(this.deps.refreshTopicStatus(active), signal);
          } catch (error) {
            if (
              error !== signal.reason &&
              !this.deps.stopped() &&
              !(error instanceof SessionCapacityError) &&
              this.deps.options.store.getSessionGeneration(active.id) === generation
            )
              this.scheduleReconnect(active, attempt + 1);
            throw error;
          }
        }).finally(() => this.reconnecting.delete(active.id));
      },
      Math.min(1000 * 2 ** attempt, 16000),
    );
    timer.unref();
    this.reconnects.set(session.id, timer);
  }
}
