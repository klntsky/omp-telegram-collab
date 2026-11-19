import type { PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptPreparation } from './prompt-preparation.js';
import type { Listener } from './types.js';
import { AuthorizationDeniedError, PromptPreparationRejectedError } from './types.js';
import { SessionCapacityError, SessionRetiringError } from '../runtime/types.js';
import { topicDestination } from '../../shared/topic-destination.js';

export interface PromptWorkerDependencies {
  options: Pick<BotOptions, 'config' | 'store' | 'runtime'>;
  shutdown: AbortSignal;
  stopped(): boolean;
  sessionAssigned(session: TopicSession): boolean;
  authorizeQueued(session: TopicSession, userId: number, authorityUserId: number): Promise<void>;
  prepareQueuedPrompt: PromptPreparation['prepareQueuedPrompt'];
  createTopicWorktree: PromptPreparation['createTopicWorktree'];
  reportQueuedFailure: PromptPreparation['reportQueuedFailure'];
  uploadDocuments: PromptPreparation['uploadDocuments'];
  listen(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<unknown>;
  listener(sessionId: string): Listener | undefined;
  sendPrompt(listener: Listener, content: PromptContent, messageId?: number, beforeSend?: (submissionId: number) => void): number;
  prepareContent(session: TopicSession, content: PromptContent): Promise<PromptContent>;
  scheduleReconnect(session: TopicSession): void;
  dropListener(sessionId: string): void;
  requestCapacity(session: TopicSession, limit: number): Promise<void>;
}

export class PromptWorker {
  private readonly drains = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  constructor(private readonly deps: PromptWorkerDependencies) {}
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const results = await Promise.allSettled(this.drains.values());
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
  drain(session: TopicSession): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.drains.get(session.id);
    if (existing) return existing;
    const previousHead = this.deps.options.store.promptQueue.first(session.id)?.id;
    const pending = this.drainSession(session).finally(() => {
      this.drains.delete(session.id);
      if (this.closed || this.deps.stopped()) return;
      const head = this.deps.options.store.promptQueue.first(session.id);
      if (head &&
          this.deps.options.store.getSession(session.id)?.status === 'open' &&
          this.deps.sessionAssigned(session) && !this.deps.options.store.isSessionPreparing(session.id) &&
          (head.state === 'submitted' || head.availableAt > Date.now() || head.id !== previousHead))
        this.schedule(session, head.state === 'submitted' ? head.acceptanceDeadline ?? Date.now() : Math.max(Date.now(), head.availableAt));
    });
    this.drains.set(session.id, pending);
    return pending;
  }
  private schedule(session: TopicSession, at: number): void {
    clearTimeout(this.timers.get(session.id));
    if (this.closed || this.deps.stopped() || this.deps.options.config.terminated) return;
    const timer = setTimeout(() => {
      this.timers.delete(session.id);
      void this.drain(session).catch(error => console.warn(`Could not resume queued prompt (${session.id}).`, error));
    }, Math.max(0, at - Date.now()));
    timer.unref();
    this.timers.set(session.id, timer);
  }
  settle(session: TopicSession, submissionId: number, outcome: 'accepted' | 'startup-rejected' | 'uncertain'): void {
    if (this.closed) return;
    const store = this.deps.options.store;
    let availableAt = Date.now();
    store.db.exec('SAVEPOINT prompt_settlement');
    try {
      if (outcome === 'startup-rejected') {
        // The native startup gate rejects before #handlePrompt, so only this outcome is safe to retry.
        // https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/collab/host.ts#L835-L837
        // Keep rejection and restored eligibility atomic: a restart must not lose known-unsent intent.
        store.rejectPromptSubmission(submissionId);
        const result = store.promptQueue.retryStartup(submissionId, Date.now());
        if (result.kind === 'retry') availableAt = result.availableAt;
      } else {
        if (outcome === 'uncertain') store.markPromptSubmissionUncertain(submissionId);
        store.promptQueue.completeSubmission(submissionId);
      }
      store.db.exec('RELEASE prompt_settlement');
    } catch (error) {
      store.db.exec('ROLLBACK TO prompt_settlement');
      store.db.exec('RELEASE prompt_settlement');
      throw error;
    }
    this.schedule(session, availableAt);
  }
  private async drainSession(session: TopicSession): Promise<void> {
    const store = this.deps.options.store;
    if (this.closed || this.deps.stopped() || this.deps.options.config.terminated ||
        store.getSession(session.id)?.status !== 'open' || !this.deps.sessionAssigned(session) || store.isSessionPreparing(session.id)) return;
    const queued = store.promptQueue.first(session.id);
    if (!queued) return;
    if (queued.state === 'submitted') {
      if ((queued.acceptanceDeadline ?? Infinity) <= Date.now() && queued.submissionId !== undefined) {
        const listener = this.deps.listener(session.id);
        const index = listener?.pendingPrompts.findIndex(item => item.submissionId === queued.submissionId) ?? -1;
        if (listener && index !== -1) listener.pendingPrompts.splice(index, 1)[0]!.observation.state = 'acceptance unknown';
        this.deps.dropListener(session.id);
        console.error('Prompt acceptance timeout.', new Error(`Prompt acceptance timed out after ${this.deps.options.config.omp.startupTimeoutMs}ms; delivery is uncertain.`), {sessionId: session.id, submissionId: queued.submissionId});
        this.settle(session, queued.submissionId, 'uncertain');
      }
      return;
    }
    if (queued.availableAt > Date.now()) return;
    const generation = store.getSessionGeneration(session.id);
    const cancellation = new Error('The queued prompt was cancelled before submission.');
    const active = () => !this.closed && store.getSession(session.id)?.status === 'open' &&
      store.getSessionGeneration(session.id) === generation && store.promptQueue.contains(queued.id);
    const authorize = async () => {
      if (!active()) throw cancellation;
      await this.deps.authorizeQueued(session, queued.userId, queued.authorityUserId);
      if (!active()) throw cancellation;
      if (this.deps.stopped()) throw new Error('The service is stopping');
    };
    let listener: Listener | undefined;
    try {
      await authorize();
      let preparation = queued.preparation;
      if (preparation?.skills?.length) {
        const available = await this.deps.options.runtime.listSkills(session.instanceId, session);
        const missing = preparation.skills.filter(name => !available.some(skill => skill.name === name));
        if (missing.length) throw new PromptPreparationRejectedError(`Skills are no longer available: ${missing.map(name => `/skill:${name}`).join(', ')}. Use /skills clear for explicit selections. Restore a missing topic-default skill, or create a new topic after changing the forum default.`);
      }
      if (preparation?.automaticWorktree) {
        await this.deps.createTopicWorktree(session, authorize);
        preparation = {...preparation, automaticWorktree: false};
        store.promptQueue.replacePreparation(queued.id, preparation);
        this.deps.dropListener(session.id);
      }
      if (preparation && (preparation.extensions?.length || preparation.preset !== undefined)) {
        await this.deps.prepareQueuedPrompt(session, preparation.extensions ?? [], authorize,
          (extensions, preset) => {
            preparation = {...preparation, extensions, preset};
            store.promptQueue.replacePreparation(queued.id, preparation);
          }, preparation.preset);
        preparation = {...preparation, extensions: []};
        store.promptQueue.replacePreparation(queued.id, preparation);
      }
      await authorize();
      if (!queued.content.text.trim() && !queued.content.images?.length && !queued.content.documents?.length) {
        store.promptQueue.remove(queued.id);
        return;
      }
      await this.deps.listen(session, authorize);
      listener = this.deps.listener(session.id);
      if (!listener) return;
      const uploaded = await this.deps.uploadDocuments(session, queued.content, authorize,
        topicDestination(session.chatId, session.threadId), remaining => store.promptQueue.replaceContent(queued.id, remaining));
      store.promptQueue.replaceContent(queued.id, uploaded);
      const expanded = preparation?.skills?.length
        ? {...uploaded, text: `${preparation.skills.map(name => `/skill:${name}`).join(' ')}\n\n${uploaded.text}`} : uploaded;
      if (preparation?.skills?.length) {
        preparation = {...preparation, skills: []};
        store.promptQueue.replacePreparedContent(queued.id, expanded, preparation);
      }
      const prompt = await this.deps.prepareContent(session, expanded);
      await authorize();
      if (this.deps.listener(session.id) !== listener) return;
      this.deps.sendPrompt(listener, prompt, queued.messageId, submissionId => {
        if (!active()) throw cancellation;
        store.promptQueue.markSubmitted(queued.id, submissionId, Date.now() + this.deps.options.config.omp.startupTimeoutMs);
      });
    } catch (error) {
      // Maintenance cancellation may interrupt a shared native operation before authorize can observe closure.
      if (error === cancellation || (this.deps.shutdown.aborted && error === this.deps.shutdown.reason)) return;
      if (error instanceof PromptPreparationRejectedError) {
        try { await this.deps.reportQueuedFailure(session, error); }
        catch (reportError) { throw new AggregateError([error, reportError], `${error.message}\n${reportError instanceof Error ? reportError.message : String(reportError)}`); }
        store.promptQueue.remove(queued.id);
        return;
      }
      if (error instanceof SessionCapacityError) { await this.deps.requestCapacity(session, error.limit); return; }
      if (error instanceof SessionRetiringError) {
        if (listener && this.deps.listener(session.id) === listener) this.deps.dropListener(session.id);
        this.deps.scheduleReconnect(session);
        return;
      }
      if (error instanceof AuthorizationDeniedError) store.promptQueue.remove(queued.id);
      throw error;
    }
  }
}
