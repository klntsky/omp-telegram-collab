import { logEvent } from '../logging.js';
import { GrammyError } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { TopicSession } from '../../shared/contracts.js';
import { TopicWriter } from '../topic-writer.js';
import type { KnownTopicActivity, TopicActivity, TopicMetadata, TopicTitleSource, HostActivityObservation, SessionMetadataOwner } from './types.js';
import type { MetadataDependencies } from './metadata-dependencies.js';

export class TopicMetadataOwners {
  readonly metadataOwners = new Map<string, SessionMetadataOwner>();
  readonly closedSessions = new Map<string, { generation: number; settled: boolean; pending?: Promise<void> }>();
  private iconIds?: Promise<Record<KnownTopicActivity, string>>;
  constructor(readonly deps: MetadataDependencies) {}
  async getIconIds(): Promise<Record<KnownTopicActivity, string>> {
    this.iconIds ??= (async () => {
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      this.deps.background.signal.addEventListener('abort', abort, {once:true});
      if (this.deps.isStopped()) abort();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const stickers = await this.deps.bot.api.getForumTopicIconStickers(controller.signal);
        const find = (emoji: string) => {
          const normalized = emoji.replace(/\uFE0F/g, '');
          const id = stickers.find(sticker => sticker.emoji?.replace(/\uFE0F/g, '') === normalized)?.custom_emoji_id;
          if (!id) throw new Error(`Telegram topic icon unavailable: ${emoji}`);
          return id;
        };
        const emojis = this.deps.options.topicActivityEmojis ?? { running: '⚡', finished: '🏁' };
        return { running: find(emojis.running), finished: find(emojis.finished) };
      } finally {
        clearTimeout(timeout);
        this.deps.background.signal.removeEventListener('abort', abort);
      }
    })().catch(error => { this.iconIds = undefined; throw error; });
    return this.iconIds;
  }
  invalidateActivity(id: string): void {
    const activity = this.metadataOwners.get(id)?.activity;
    if (activity) {
      activity.controller?.abort(
        new Error('Activity observation canceled because its listener closed'),
      );
      activity.value = 'unknown';
      activity.observedAt = undefined;
      activity.suspect = true;
      ++activity.revision;
    }
  }
  disposeMetadataOwner(id: string): void {
    const owner = this.metadataOwners.get(id);
    if (!owner) return;
    this.invalidateActivity(id);
    owner.disposed = true;
    owner.controller.abort(new Error('Session metadata ownership changed'));
    owner.metadata = undefined;
    owner.recovery = undefined;
    if (!owner.titleWrite) this.metadataOwners.delete(id);
  }
  metadataOwner(session: TopicSession): SessionMetadataOwner {
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    let owner = this.metadataOwners.get(session.id);
    if (!owner) {
      owner = {
        generation,
        disposed: false,
        controller: new AbortController(),
        activity: { generation, value: 'unknown', suspect: false, revision: 0 },
        title: {
          prefix: this.deps.options.store.getTopicTitlePrefix(session.id) ?? '',
          prefixes: new Set(),
          revision: 0,
        },
      };
      this.metadataOwners.set(session.id, owner);
    } else if (owner.disposed || owner.generation !== generation) {
      this.disposeMetadataOwner(session.id);
      owner.generation = generation;
      owner.disposed = false;
      owner.controller = new AbortController();
      owner.activity = { generation, value: 'unknown', suspect: false, revision: 0 };
      owner.title = {
        prefix: this.deps.options.store.getTopicTitlePrefix(session.id) ?? '',
        prefixes: new Set(),
        revision: 0,
      };
      this.metadataOwners.set(session.id, owner);
    }
    return owner;
  }
  activityObservation(session: TopicSession): HostActivityObservation {
    return this.metadataOwner(session).activity;
  }
  titleSource(session: TopicSession): TopicTitleSource {
    return this.metadataOwner(session).title;
  }
  activityAtUse(session: TopicSession): TopicActivity {
    const owner = this.metadataOwners.get(session.id);
    if (
      !owner ||
      owner.disposed ||
      owner.generation !== this.deps.options.store.getSessionGeneration(session.id)
    )
      return 'unknown';
    const status = this.deps.options.store.getSession(session.id)?.status;
    if (status === 'open' && this.deps.options.store.hasPendingInitialTask(session.id)) return 'running';
    const activity = owner.activity;
    const closed = this.closedSessions.get(session.id);
    if (
      activity.value === 'finished' &&
      status === 'closed' &&
      closed?.generation === owner.generation &&
      closed.settled
    )
      return 'finished';
    return activity.observedAt !== undefined && Date.now() - activity.observedAt < 60_000
      ? activity.value
      : 'unknown';
  }
  formatTopicTitle(source: TopicTitleSource): { name: string; prefix: string } {
    const title = source.humanTitle ?? '';
    const prefixLimit = 127 - Math.min(Array.from(title).length, 64);
    const characters = Array.from(source.prefix);
    const prefix =
      characters.length > prefixLimit
        ? `${characters.slice(0, prefixLimit - 1).join('')}…`
        : source.prefix;
    return {
      name: Array.from(`${prefix ? `${prefix} ` : ''}${title}`)
        .slice(0, 128)
        .join(''),
      prefix,
    };
  }
  topicMetadata(session: TopicSession): TopicMetadata {
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const owner = this.metadataOwner(session);
    let metadata = owner.metadata;
    if (metadata?.generation === generation) return metadata;
    const owned = () =>
      !this.deps.isStopped() &&
      !this.deps.options.config.terminated &&
      !owner.disposed &&
      owner.metadata === metadata &&
      this.deps.sessionAssigned(session) &&
      this.deps.options.store.getSessionGeneration(session.id) === generation;
    const writer = (field: 'name' | 'icon'): TopicWriter => {
      const eligible = () => {
        if (!owned()) return false;
        if (field === 'icon' && this.activityAtUse(session) === 'unknown') return false;
        const status = this.deps.options.store.getSession(session.id)?.status;
        return (
          status === 'open' ||
          (field === 'icon' &&
            status === 'closed' &&
            this.activityAtUse(session) === 'finished' &&
            this.closedSessions.get(session.id)?.settled === true)
        );
      };
      const result = new TopicWriter(
        (take) =>
          this.deps.delivery.runTopic(
            session.chatId,
            field,
            session.id,
            async (signal) => {
              if (!eligible()) return;
              const value = take();
              if (value === undefined) return;
              try {
                await this.deps.bot.api.editForumTopic(
                  session.chatId,
                  session.threadId,
                  field === 'name' ? { name: value } : { icon_custom_emoji_id: value },
                  signal,
                );
              } catch (error) {
                if (
                  !(
                    error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED')
                  )
                )
                  throw error;
              }
              if (owned()) {
                void result.observe(value);
                if (field === 'name') {
                  const source = owner.title;
                  if (source) {
                    const current = this.formatTopicTitle(source);
                    if (current.name === value)
                      this.deps.options.store.setTopicTitle(session.id, value, current.prefix);
                  }
                }
                if (
                  field === 'icon' &&
                  this.deps.options.store.getSession(session.id)?.status === 'closed' &&
                  value === this.topicIconValue(session, await this.getIconIds()) &&
                  owned()
                )
                  this.deps.options.store.completeCloseIcon(session.id);
              }
              return value;
            },
            eligible,
          ),
        eligible,
        (error) => {
          if (!owned()) return;
          this.deps.sessionObservation(session.id).failure = {
            operation:
              field === 'name' ? 'Topic title synchronization' : 'Topic icon synchronization',
            at: Date.now(),
            error,
          };
          logEvent('warn', 'could-not-synchronize-topic', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, field, message: `Could not synchronize topic ${field} (${session.id}).`, error});
        },
      );
      return result;
    };
    metadata = { generation, name: writer('name'), icon: writer('icon') };
    owner.metadata = metadata;
    return metadata;
  }
  topicIconValue(
    session: TopicSession,
    ids: Record<KnownTopicActivity, string>,
  ): string | undefined {
    const activity = this.activityAtUse(session);
    if (activity === 'unknown') return undefined;
    let preference = this.deps.options.store.getTopicFinishIcon(session.id);
    if (preference === ids.running) {
      this.deps.options.store.setTopicFinishIcon(session.id, undefined);
      preference = undefined;
    }
    return activity === 'running' ? ids.running : (preference ?? ids.finished);
  }
  disposeAll(): (Promise<void> | undefined)[] {
    const completions = [...this.metadataOwners.values()].flatMap(owner => [
      owner.metadata?.name.completion, owner.metadata?.icon.completion, owner.titleWrite,
    ]);
    for (const id of this.metadataOwners.keys()) this.disposeMetadataOwner(id);
    return completions;
  }
}
