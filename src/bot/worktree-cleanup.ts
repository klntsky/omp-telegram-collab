import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Bot, Context } from 'grammy';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import type { Omp, WorktreeTarget } from '../omp.js';
import type { Store } from '../store.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { refreshTermination } from '../config.js';

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

interface CleanupDependencies {
  bot: Bot<Context>;
  config: AppConfig;
  store: Store;
  runtime: Omp;
  delivery: TelegramDelivery;
  botId(): number;
  stopped(): boolean;
  sessionAssigned(session: TopicSession): boolean;
  authorizeSession(session: TopicSession, userId: number): Promise<boolean>;
}

interface CleanupOffer {
  session: TopicSession;
  generation: number;
  target: WorktreeTarget;
  messageId: number;
  adminId?: number;
}

export class WorktreeCleanup {
  private readonly offers = new Map<string, CleanupOffer>();
  constructor(private readonly deps: CleanupDependencies) {}

  private active(offer: CleanupOffer): boolean {
    const { session, generation } = offer;
    const stored = this.deps.store.getSession(session.id);
    return !this.deps.stopped() && !refreshTermination(this.deps.config) &&
      session.botId === this.deps.botId() && this.deps.sessionAssigned(session) &&
      stored?.status === 'closed' && stored.cwd === offer.target.path && stored.runtime.kind === 'managed' &&
      this.deps.store.getSessionGeneration(session.id) === generation;
  }

  async offer(source: TopicSession, generation: number): Promise<void> {
    const session = this.deps.store.getSession(source.id);
    if (!session || session.status !== 'closed' || session.runtime.kind !== 'managed') return;
    const target = await this.deps.runtime.inspectWorktree(session);
    if (!target) return;
    const offer: CleanupOffer = { session, generation, target, messageId: 0 };
    if (!this.active(offer)) return;
    for (const [token, previous] of this.offers) {
      if (previous.session.id !== session.id) continue;
      if (previous.generation === generation) return;
      this.offers.delete(token);
    }
    const token = randomBytes(16).toString('base64url');
    this.offers.set(token, offer);
    // Manage Topics permits outgoing messages in closed topics. Do not reopen to send this offer.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp#L1274-L1284 (can_send_message_to_forum_topic)
    try {
      const message = await this.deps.delivery.run(session.chatId, () => this.deps.bot.api.sendMessage(session.chatId,
        `🌳 This topic used this Git worktree:\n${target.path}\n\nA group administrator can delete it after explicit confirmation. Session history is kept.`, {
          message_thread_id: session.threadId,
          reply_markup: { inline_keyboard: [[{ text: '🌳 Delete worktree', callback_data: `wtcleanup:offer:${token}` }]] },
        }), () => this.active(offer));
      if (message && this.active(offer)) offer.messageId = message.message_id;
      else this.offers.delete(token);
    } catch (error) {
      this.offers.delete(token);
      throw error;
    }
  }

  async callback(ctx: Context, data: string): Promise<void> {
    const match = /^wtcleanup:(offer|confirm|cancel):([A-Za-z0-9_-]{22})$/.exec(data);
    const message = ctx.callbackQuery?.message;
    if (!match || !message || !('from' in message) || message.from?.id !== this.deps.botId() ||
        !ctx.from || ctx.from.is_bot || ctx.chat?.type !== 'supergroup' ||
        'forward_origin' in message || 'forward_date' in message) return;
    const [, action, token] = match;
    const offer = this.offers.get(token!);
    if (!offer || message.chat.id !== offer.session.chatId || message.message_thread_id !== offer.session.threadId ||
        message.message_id !== offer.messageId || !this.active(offer)) {
      await ctx.answerCallbackQuery({ text: 'This worktree cleanup offer expired.' });
      return;
    }
    if ((action === 'offer') !== (offer.adminId === undefined) || (offer.adminId !== undefined && offer.adminId !== ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: 'Only the administrator who requested confirmation can use it.' });
      return;
    }
    if (!(await this.deps.authorizeSession(offer.session, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'A current group administrator is required.' });
      return;
    }
    if (!this.active(offer) || this.offers.get(token!) !== offer) {
      await ctx.answerCallbackQuery({ text: 'This worktree cleanup offer expired.' });
      return;
    }
    // Consume before awaiting further work so concurrent callbacks cannot replay deletion.
    this.offers.delete(token!);
    await ctx.answerCallbackQuery();
    if (action === 'cancel') {
      await this.edit(offer, `🌳 Worktree deletion cancelled.\n${offer.target.path}`);
    } else if (action === 'offer') {
      const confirmation = randomBytes(16).toString('base64url');
      const bound: CleanupOffer = { ...offer, adminId: ctx.from.id };
      await this.edit(bound, `🌳 Permanently delete this entire Git worktree directory?\n${offer.target.path}\n\nThis deletion is irreversible. Git will refuse dirty or locked worktrees. Session history will remain.`, [
        [{ text: '🌳 Confirm deletion', callback_data: `wtcleanup:confirm:${confirmation}` }],
        [{ text: 'Cancel', callback_data: `wtcleanup:cancel:${confirmation}` }],
      ]);
      if (this.active(bound)) this.offers.set(confirmation, bound);
    } else {
      await this.deps.runtime.deleteWorktree(offer.session, offer.target, async () => {
        if (!(await this.deps.authorizeSession(offer.session, offer.adminId!))) throw new Error('Administrator access changed before worktree deletion.');
        if (!this.active(offer)) throw new Error('This worktree cleanup offer expired.');
        for (const other of this.deps.store.listSessions()) {
          if (other.id !== offer.session.id && (contains(offer.target.path, other.cwd) || contains(other.cwd, offer.target.path))) {
            throw new Error(`Another session uses this worktree: ${other.id}`);
          }
        }
      });
      await this.edit(offer, `🌳 Deleted Git worktree:\n${offer.target.path}\n\nSession history has been kept. Reopening this topic will not recreate the directory.`);
    }
  }

  private async edit(offer: CleanupOffer, text: string, inline_keyboard: { text: string; callback_data: string }[][] = []): Promise<void> {
    await this.deps.delivery.run(offer.session.chatId, () => this.deps.bot.api.editMessageText(
      offer.session.chatId, offer.messageId, text, { reply_markup: { inline_keyboard } },
    ), () => this.active(offer));
  }
}
