import { logEvent } from '../logging.js';
import type { TopicSession } from '../../shared/contracts.js';
import { withCancellation } from '../cancellation.js';
import type { TopicActivity } from './types.js';
import type { MetadataDependencies, ActivityDependencies } from './metadata-dependencies.js';
import { TopicMetadataOwners } from './topic-metadata-owners.js';
import { TopicTitles } from './topic-titles.js';

export class TopicActivityMonitor {
  constructor(
    private readonly deps: MetadataDependencies,
    private readonly owners: TopicMetadataOwners,
    private readonly titles: TopicTitles,
    private readonly activity: ActivityDependencies,
  ) {}
  setTopicStatus(
    session: TopicSession,
    activity: TopicActivity,
    suspect = false,
  ): Promise<void> {
    if (this.deps.isStopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session))
      return Promise.resolve();
    const observation = this.owners.activityObservation(session);
    observation.value = activity;
    observation.observedAt = activity === 'unknown' ? undefined : Date.now();
    observation.suspect = suspect;
    ++observation.revision;
    return this.publishTopicIcon(session);
  }
  async publishTopicIcon(session: TopicSession): Promise<void> {
    if (this.deps.isStopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session)) return;
    if (
      this.deps.options.store.getSession(session.id)?.status === 'closed' &&
      !this.deps.options.store.hasPendingCloseIcon(session.id)
    )
      return;
    const metadata = this.owners.topicMetadata(session);
    if (this.owners.activityAtUse(session) === 'unknown') return;
    try {
      const ids = await this.owners.getIconIds();
      if (
        this.deps.isStopped() ||
        this.owners.metadataOwners.get(session.id)?.metadata !== metadata ||
        !this.deps.sessionAssigned(session) ||
        this.deps.options.store.getSessionGeneration(session.id) !== metadata.generation
      )
        return;
      const value = this.owners.topicIconValue(session, ids);
      if (value !== undefined) await metadata.icon.publish(value);
    } catch (error) {
      if (!this.deps.isStopped() && !this.deps.options.config.terminated &&
          this.owners.metadataOwners.get(session.id)?.metadata === metadata &&
          this.deps.sessionAssigned(session) &&
          this.deps.options.store.getSessionGeneration(session.id) === metadata.generation) {
        logEvent('warn', 'could-not-synchronize-topic-icon', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not synchronize topic icon (${session.id}).`, error});
        this.deps.sessionObservation(session.id).failure = {
          operation: 'Topic icon synchronization',
          at: Date.now(),
          error,
        };
      }
    }
  }
  refreshActivity(session: TopicSession): Promise<void> {
    const observation = this.owners.activityObservation(session);
    if (observation.probe) return observation.probe;
    const revision = observation.revision;
    const controller = new AbortController();
    observation.controller = controller;
    const signal = AbortSignal.any([this.deps.background.signal, controller.signal]);
    const timeout = setTimeout(
      () => controller.abort(new Error('Host activity lookup timed out after 5 seconds')),
      5000,
    );
    const active = () =>
      !this.deps.isStopped() &&
      !this.deps.options.config.terminated &&
      this.owners.metadataOwners.get(session.id)?.activity === observation &&
      observation.revision === revision &&
      this.deps.sessionAssigned(session) &&
      this.deps.options.store.getSessionGeneration(session.id) === observation.generation &&
      this.deps.options.store.getSession(session.id)?.status === 'open';
    const probe = (async () => {
      const binding = await withCancellation(this.deps.options.runtime.resolveExisting(session), signal);
      if (!active()) return;
      if (!binding) {
        void this.setTopicStatus(session, 'finished');
        return;
      }
      const state = await withCancellation(
        this.deps.options.runtime.readCollabState(
          binding,
          `Telegram @${this.deps.bot.botInfo!.username} activity`,
          signal,
        ),
        signal,
      );
      if (!active()) return;
      const listener = this.activity.getListener(session.id);
      if (listener) listener.queuedMessages = state.queuedMessageCount;
      void this.setTopicStatus(
        session,
        state.isStreaming ||
          state.queuedMessageCount > 0 ||
          this.deps.options.store.hasPendingInitialTask(session.id)
          ? 'running'
          : 'finished',
      );
    })()
      .catch((error) => {
        if (active()) {
          logEvent('warn', 'could-not-look-up-host-activity', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not look up host activity (${session.id}).`, error});
          void this.setTopicStatus(session, 'unknown');
          this.deps.sessionObservation(session.id).failure = {
            operation: 'Host status lookup',
            at: Date.now(),
            error,
          };
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (observation.probe === probe) {
          observation.probe = undefined;
          observation.controller = undefined;
        }
      });
    observation.probe = probe;
    return probe;
  }
  async refreshTopicStatus(session: TopicSession): Promise<void> {
    if (this.deps.isStopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session)) return;
    if (this.deps.options.store.getSession(session.id)?.status === 'closed') {
      const state = this.owners.closedSessions.get(session.id);
      if (
        !state ||
        state.generation !== this.deps.options.store.getSessionGeneration(session.id) ||
        (!state.settled && !state.pending)
      ) {
        void this.activity.runBackground(`close:${session.id}`, () => this.windDownClosedSession(session));
      } else if (state.settled) {
        void this.publishTopicIcon(session);
      }
      return;
    }
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const listener = this.activity.getListener(session.id);
    if (listener && listener.generation !== generation) this.activity.dropListener(session.id);
    const current = this.activity.getListener(session.id);
    if (current) {
      this.titles.syncTopicTitle(session, current);
    } else {
      const source = this.owners.titleSource(session);
      const revision = source.revision;
      const title =
        this.deps.options.store.getPendingSessionTitle(session.id) ??
        source.humanTitle ??
        this.titles.stripTopicStatus(session, session.name);
      void this.titles.projectTopicTitle(
        session,
        title,
        () =>
          !this.deps.isStopped() &&
          this.deps.sessionAssigned(session) &&
          this.deps.options.store.getSession(session.id)?.status === 'open' &&
          this.deps.options.store.getSessionGeneration(session.id) === generation &&
          this.owners.metadataOwners.get(session.id)?.title === source &&
          source.revision === revision,
      );
    }
    const observation = this.owners.activityObservation(session);
    const age = Date.now() - (observation.observedAt ?? 0);
    if (observation.suspect || age >= 30_000) {
      if (observation.suspect || age >= 60_000) void this.setTopicStatus(session, 'unknown');
      await this.refreshActivity(session);
    }
    if (
      !this.deps.isStopped() &&
      this.deps.sessionAssigned(session) &&
      this.deps.options.store.getSessionGeneration(session.id) === generation
    )
      void this.publishTopicIcon(session);
  }
  windDownClosedSession(session: TopicSession): Promise<void> {
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    let state = this.owners.closedSessions.get(session.id);
    if (!state || state.generation !== generation) {
      state = { generation, settled: false };
      this.owners.closedSessions.set(session.id, state);
      this.deps.options.store.cancelInitialTask(session.id);
      this.owners.invalidateActivity(session.id);
      this.activity.dropListener(session.id);
      this.activity.clearSessionRequests(session.id);
    }
    if (state.settled) return this.setTopicStatus(session, 'finished');
    if (state.pending) return state.pending;
    const current = state;
    const pending = (
      session.runtime.kind === 'attached'
        ? this.deps.options.runtime.isRunning(session).then((running) => !running)
        : this.deps.options.runtime.stop(session)
    )
      .then(async (settled) => {
        if (
          this.deps.isStopped() ||
          this.deps.options.config.terminated ||
          !this.deps.sessionAssigned(session) ||
          this.owners.closedSessions.get(session.id) !== current ||
          this.deps.options.store.getSessionGeneration(session.id) !== generation ||
          this.deps.options.store.getSession(session.id)?.status !== 'closed'
        )
          return;
        current.settled = settled;
        if (settled) await this.setTopicStatus(session, 'finished');
      })
      .finally(() => {
        current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }
}
