import type { Bot, Context } from 'grammy';
import { stat } from 'node:fs/promises';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import type { TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { renderTelegramMarkdown } from '../telegram-markdown.js';
import { readReplyHistory } from './reply-history.js';

interface ReplyDeliveryDependencies {
  bot: Bot<Context>;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
  delivery: TelegramDelivery;
  ready(chatId: number): Promise<boolean>;
  sessionAssigned(session: TopicSession): boolean;
  stopped(): boolean;
  runBackground(phase: string, operation: () => Promise<void>): Promise<void>;
}

export class ReplyDelivery {
  private readonly drains = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly recoveryRequested = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly captured = new Map<string, string>();
  constructor(private readonly deps: ReplyDeliveryDependencies) {}

  accept(session: TopicSession, ompSessionId: string, entry: SessionEntry, replyTo?: number, historical = false): void {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return;
    const text = entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (!text.trim()) return;
    const store = this.deps.options.store;
    store.replies.stage(session.id, ompSessionId, entry.id, entry.parentId,
      historical ? [] : renderTelegramMarkdown(text), replyTo, store.getSessionGeneration(session.id), historical);
  }

  wake(session: TopicSession, recover = false): void {
    if (this.deps.stopped() || this.deps.options.config.terminated ||
        Date.now() < (this.retryAfter.get(session.id) ?? 0)) return;
    this.requested.add(session.id);
    if (recover) this.recoveryRequested.add(session.id);
    if (this.drains.has(session.id)) return;
    // Coalesce before creating background tasks, including upgrades to history recovery.
    const operation = this.deps.runBackground(`reply-delivery:${session.id}`, async () => {
      try {
        do {
          if (this.recoveryRequested.delete(session.id)) await this.recover(session);
          else await this.deliver(session);
        } while (this.requested.has(session.id) || this.recoveryRequested.has(session.id));
        this.retryAfter.delete(session.id);
      } catch (error) {
        // Every event shares this cooldown; existing maintenance provides the next wake.
        this.retryAfter.set(session.id, Date.now() + 30000);
        throw error;
      }
    }).finally(() => {
      this.drains.delete(session.id);
      this.requested.delete(session.id);
      this.recoveryRequested.delete(session.id);
    });
    this.drains.set(session.id, operation);
  }

  private async recover(session: TopicSession): Promise<void> {
    await this.deliver(session);
    if (session.runtime.kind !== 'managed' || this.deps.stopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session) || session.status !== 'open') return;
    await this.capture(session);
    this.requested.add(session.id);
    await this.deliver(session);
  }

  private async capture(session: TopicSession): Promise<void> {
    const store = this.deps.options.store;
    const generation = store.getSessionGeneration(session.id);
    const source = await this.deps.options.runtime.historySource(session);
    if (!source) return;
    const metadata = await stat(source.path, { bigint: true });
    const stamp = `${source.sessionId}:${source.path}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`;
    if (this.captured.get(session.id) === stamp) return;
    const entries = await readReplyHistory(source);
    if (this.deps.stopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session) || store.getSessionGeneration(session.id) !== generation || store.getSession(session.id)?.status !== 'open') return;
    const historical = !store.hasSnapshot(session.id);
    let replyTo: number | undefined;
    // Native replication includes all wire entries, not a reconstructed active branch.
    // This reader recovers only outbound text; browser history still uses native snapshots.
    // https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/collab/host.ts#L906-L912
    for (const entry of entries) {
      if (entry.type === 'custom_message' && entry.customType === 'collab-prompt') {
        replyTo = store.replies.getReceiptMessageId(session.id, source.sessionId, entry.id);
      } else this.accept(session, source.sessionId, entry, replyTo, historical);
    }
    this.captured.set(session.id, stamp);
    store.markSnapshot(session.id);
  }

  private async deliver(session: TopicSession): Promise<void> {
    const store = this.deps.options.store;
    while (this.requested.delete(session.id)) {
      if (this.deps.stopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session)) return;
      const pending = store.replies.pending(session.id);
      if (!pending.length) continue;
      if (store.getSession(session.id)?.status !== 'open') {
        for (const reply of pending) store.replies.discard(reply);
        return;
      }
      if (!await this.deps.ready(session.chatId)) return;
      for (const reply of pending) {
        const current = store.getSession(session.id);
        if (current?.status !== 'open' || store.getSessionGeneration(session.id) !== reply.generation) {
          store.replies.discard(reply);
          continue;
        }
        const active = () => !this.deps.stopped() && !this.deps.options.config.terminated &&
          this.deps.sessionAssigned(current) && store.getSession(session.id)?.status === 'open' &&
          store.getSessionGeneration(session.id) === reply.generation;
        while (reply.nextPart < reply.parts.length) {
          const sent = await this.deps.delivery.run(session.chatId, async () => {
            if (!active()) return undefined;
            try {
              const result = await this.deps.bot.api.sendRichMessage(session.chatId, { markdown: reply.parts[reply.nextPart]! }, {
                message_thread_id: session.threadId === 1 ? undefined : session.threadId,
                ...(reply.replyTo === undefined ? {} : { reply_parameters: { message_id: reply.replyTo, allow_sending_without_reply: true } }),
              });
              store.replies.confirm(reply, result.chat.id, result.message_id);
              return result;
            } catch (error) {
              // Leave unconfirmed chunks pending: a lost acknowledgement may duplicate
              // a reply on retry, but must not permanently suppress its delivery.
              try { store.replies.fail(reply, error); }
              catch (failure) { throw new AggregateError([error, failure], `${error instanceof Error ? error.message : String(error)}\n${failure instanceof Error ? failure.message : String(failure)}`); }
              throw error;
            }
          }, active);
          if (!sent) return;
          reply.nextPart++;
        }
      }
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.drains.values());
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
}
