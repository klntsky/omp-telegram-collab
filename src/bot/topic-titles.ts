import { logEvent } from '../logging.js';
import type { TopicSession } from '../../shared/contracts.js';
import { refreshTermination } from '../config.js';
import { SessionTitleUnsupportedError } from '../runtime/types.js';
import { withCancellation } from '../cancellation.js';
import type { Listener } from './types.js';
import type { MetadataDependencies } from './metadata-dependencies.js';
import { TopicMetadataOwners } from './topic-metadata-owners.js';

export class TopicTitles {
  constructor(
    private readonly deps: MetadataDependencies,
    private readonly owners: TopicMetadataOwners,
    private readonly getListener: (id: string) => Listener | undefined,
  ) {}
  applySessionTitle(session: TopicSession): Promise<void> {
    const owner = this.owners.metadataOwner(session);
    if (owner.titleWrite) return owner.titleWrite;
    const write = async () => {
      let attempted: { title: string; generation: number } | undefined;
      while (!this.deps.isStopped() && !refreshTermination(this.deps.options.config) && !owner.disposed) {
        const current = this.deps.options.store.getSession(session.id);
        if (!current || current.status !== 'open' || !this.deps.sessionAssigned(current)) return;
        const generation = this.deps.options.store.getSessionGeneration(session.id);
        const title = this.deps.options.store.getPendingSessionTitle(session.id);
        if (
          title === undefined ||
          (attempted?.title === title && attempted.generation === generation)
        )
          return;
        attempted = { title, generation };
        const source = owner.title;
        try {
          await this.deps.options.runtime.setSessionTitle(current, title);
        } catch (error) {
          if (!this.deps.isStopped() && !this.deps.options.config.terminated && !owner.disposed &&
              owner.generation === generation && owner.title === source &&
              this.deps.sessionAssigned(current) &&
              this.deps.options.store.getSessionGeneration(session.id) === generation) {
            logEvent('warn', 'could-not-synchronize-session-title', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not synchronize session title (${session.id}).`, error});
            this.deps.sessionObservation(session.id).failure = {
              operation: 'Session title synchronization',
              at: Date.now(),
              error,
            };
            if (
              !this.deps.isStopped() &&
              error instanceof SessionTitleUnsupportedError &&
              this.deps.options.store.getPendingSessionTitle(session.id) === title &&
              this.deps.options.store.getSessionGeneration(session.id) === generation &&
              this.deps.sessionAssigned(current) &&
              this.deps.options.store.getSession(session.id)?.status === 'open'
            ) {
              this.deps.options.store.setPendingSessionTitle(session.id, undefined);
            }
          }
        }
      }
    };
    const pending = Promise.resolve()
      .then(write)
      .finally(() => {
        if (owner.titleWrite === pending) owner.titleWrite = undefined;
        if (owner.disposed && this.owners.metadataOwners.get(session.id) === owner)
          this.owners.metadataOwners.delete(session.id);
      });
    owner.titleWrite = pending;
    return pending;
  }
  stripTopicStatus(session: TopicSession, title: string): string {
    const savedPrefix = this.deps.options.store.getTopicTitlePrefix(session.id);
    if (savedPrefix && title.startsWith(`${savedPrefix} `))
      return title.slice(savedPrefix.length + 1);
    for (const prefix of this.owners.metadataOwners.get(session.id)?.title.prefixes ?? []) {
      if (title.startsWith(`${prefix} `)) return title.slice(prefix.length + 1);
    }
    if (title.startsWith('🌳 ')) return title.slice('🌳 '.length);
    return title;
  }
  async projectTopicTitle(
    session: TopicSession,
    title: string,
    active: () => boolean,
  ): Promise<void> {
    const callerActive = active;
    active = () => callerActive() && this.deps.options.store.getTopicKind(session) === 'tracked';
    if (!active()) return;
    const source = this.owners.titleSource(session);
    const initial = source.humanTitle === undefined;
    source.humanTitle = title;
    const publish = () => {
      const current = this.owners.formatTopicTitle(source);
      if (!current.name.trim()) return;
      if (current.prefix) source.prefixes.add(current.prefix);
      void this.owners.topicMetadata(session).name.publish(current.name);
    };
    publish();
    try {
      const status = await withCancellation(
        this.deps.options.runtime.topicTitleStatus(session),
        AbortSignal.any([this.deps.background.signal, AbortSignal.timeout(5000)]),
      );
      if (!active() || this.owners.metadataOwners.get(session.id)?.title !== source) return;
      const topicBranch = `t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`;
      const branch = status.branch === topicBranch ? '' : (status.branch ?? '');
      source.prefix = status.worktree ? `🌳${branch ? ` ${branch}` : ''}` : branch;
      if (initial && source.prefix && source.humanTitle?.startsWith(`${source.prefix} `))
        source.humanTitle = source.humanTitle.slice(source.prefix.length + 1);
      publish();
    } catch (error) {
      if (!active() || this.owners.metadataOwners.get(session.id)?.title !== source) return;
      logEvent('warn', 'could-not-synchronize-topic-title', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not synchronize topic title (${session.id}).`, error});
      this.deps.sessionObservation(session.id).failure = {
        operation: 'Topic title synchronization',
        at: Date.now(),
        error,
      };
    }
  }
  syncTopicTitle(session: TopicSession, listener: Listener, title?: string): void {
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const source = this.owners.titleSource(session);
    const revision = ++source.revision;
    const active = () =>
      !this.deps.isStopped() &&
      !refreshTermination(this.deps.options.config) &&
      this.deps.sessionAssigned(session) &&
      this.getListener(session.id) === listener &&
      this.deps.options.store.getSession(session.id)?.status === 'open' &&
      this.deps.options.store.getSessionGeneration(session.id) === generation &&
      source.revision === revision;
    void (async () => {
      if (!active()) return;
      const pending = this.deps.options.store.getPendingSessionTitle(session.id);
      if (pending !== undefined) {
        if (pending === title) this.deps.options.store.setPendingSessionTitle(session.id, undefined);
        else await this.applySessionTitle(session);
      }
      if (!active()) return;
      const human =
        this.deps.options.store.getPendingSessionTitle(session.id) ??
        (pending === undefined ? title : undefined) ??
        source.humanTitle ??
        this.stripTopicStatus(
          session,
          this.deps.options.store.getSession(session.id)?.name ?? session.name,
        );
      if (pending !== undefined || title !== undefined) source.humanTitle = human;
      await this.projectTopicTitle(session, human, active);
    })().catch((error) => {
      if (!active()) return;
      logEvent('warn', 'could-not-synchronize-topic-title', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not synchronize topic title (${session.id}).`, error});
      this.deps.sessionObservation(session.id).failure = {
        operation: 'Topic title synchronization',
        at: Date.now(),
        error,
      };
    });
  }
}
