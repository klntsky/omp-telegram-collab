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

// Volatile coordination only; SQLite owns payloads and confirmed delivery progress.
interface ReplyWork {
  task?: Promise<void>;
  next?: 'delivery' | 'recovery';
  captured?: string;
}

export class ReplyDelivery {
  private readonly work = new Map<string, ReplyWork>();
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
    if (this.deps.stopped() || this.deps.options.config.terminated) return;
    const work: ReplyWork = this.work.get(session.id) ?? {};
    if (!work.task && Date.now() < this.deps.options.store.replies.retryAfter(session.id)) return;
    work.next = recover || work.next === 'recovery' ? 'recovery' : 'delivery';
    if (work.task) return;
    this.work.set(session.id, work);
    // Coalesce before creating background tasks, including upgrades to history recovery.
    work.task = this.deps.runBackground(`reply-delivery:${session.id}`, async () => {
      try {
        while (work.next) {
          const next = work.next;
          work.next = undefined;
          await this.deliver(session);
          if (next === 'recovery' && session.runtime.kind === 'managed' && !this.deps.stopped() &&
              !this.deps.options.config.terminated && this.deps.sessionAssigned(session) && session.status === 'open') {
            await this.capture(session, work);
            await this.deliver(session);
          }
        }
      } catch (error) {
        // Persist the deadline so reconnects and service restarts share the same cooldown.
        try { this.deps.options.store.replies.defer(session.id, Date.now() + 30000); }
        catch (failure) { throw new AggregateError([error, failure], `${error instanceof Error ? error.message : String(error)}\n${failure instanceof Error ? failure.message : String(failure)}`); }
        throw error;
      }
    }).finally(() => {
      work.task = undefined;
      work.next = undefined;
    });
  }

  private async capture(session: TopicSession, work: ReplyWork): Promise<void> {
    const store = this.deps.options.store;
    const generation = store.getSessionGeneration(session.id);
    const source = await this.deps.options.runtime.historySource(session);
    if (!source) return;
    const metadata = await stat(source.path, { bigint: true });
    const stamp = `${source.sessionId}:${source.path}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`;
    if (work.captured === stamp) return;
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
    work.captured = stamp;
    store.markSnapshot(session.id);
  }

  private async deliver(session: TopicSession): Promise<void> {
    const store = this.deps.options.store;
    if (this.deps.stopped() || this.deps.options.config.terminated || !this.deps.sessionAssigned(session)) return;
    const pending = store.replies.pending(session.id);
    if (!pending.length) return;
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

  async close(): Promise<void> {
    const results = await Promise.allSettled(Array.from(this.work.values(), work => work.task));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
}
