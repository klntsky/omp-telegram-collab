import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
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

async function canonicalPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const missing: string[] = [];
  while (true) {
    try { return path.join(await realpath(current), ...missing); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertWorktreeSessionSafety(config: AppConfig, store: Store, session: TopicSession, target: WorktreeTarget): Promise<void> {
  const protectedPaths = [config.dataDir, config.configPath,
    ...config.instances.flatMap(instance => [instance.defaultDir, ...instance.chats.flatMap(chat => (chat.folder_options ?? []).map(option => path.resolve(instance.defaultDir, option)))])];
  for (const configured of protectedPaths) {
    if (contains(target.path, path.resolve(configured)) || contains(target.path, await canonicalPath(configured))) {
      throw new Error(`Worktree contains a protected configured path: ${configured}`);
    }
  }
  for (const other of store.listSessions()) {
    if (other.id === session.id) continue;
    const cwd = await canonicalPath(other.cwd);
    if (contains(target.path, cwd) || contains(cwd, target.path) || contains(target.path, path.resolve(other.cwd))) {
      throw new Error(`Another session uses this worktree: ${other.id}`);
    }
  }
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
  authorize(chatId: number, userId: number): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
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
  private readonly announced = new Map<string, number>();
  constructor(private readonly deps: CleanupDependencies) {}

  private active(offer: CleanupOffer): boolean {
    const { session, generation } = offer;
    const stored = this.deps.store.getSession(session.id);
    return !this.deps.stopped() && !refreshTermination(this.deps.config) &&
      session.botId === this.deps.botId() && this.deps.sessionAssigned(session) &&
      stored?.status === 'closed' && stored.cwd === offer.target.path && stored.runtime.kind === 'managed' &&
      this.deps.store.getSessionGeneration(session.id) === generation;
  }

  private requireActive(offer: CleanupOffer): void {
    if (!this.active(offer)) throw new Error('This worktree cleanup offer expired.');
  }

  async offer(source: TopicSession, generation: number): Promise<void> {
    const session = this.deps.store.getSession(source.id);
    if (!session || session.status !== 'closed') return;
    if (session.runtime.kind !== 'managed' || this.announced.get(session.id) === generation) return;
    const target = await this.deps.runtime.inspectWorktree(session);
    if (!target) return;
    const offer: CleanupOffer = { session, generation, target, messageId: 0 };
    if (!this.active(offer)) return;
    await assertWorktreeSessionSafety(this.deps.config, this.deps.store, session, target);
    if (!this.active(offer) || this.announced.get(session.id) === generation) return;
    this.announced.set(session.id, generation);
    for (const [token, previous] of this.offers) if (previous.session.id === session.id) this.offers.delete(token);
    const token = randomBytes(16).toString('base64url');
    // Manage Topics permits outgoing messages in closed topics. Do not reopen to send this offer.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp#L1274-L1284 (can_send_message_to_forum_topic)
    let message;
    try {
      message = await this.deps.delivery.run(session.chatId, () => this.deps.bot.api.sendMessage(session.chatId,
        `🌳 This topic used this Git worktree:\n${target.path}\n\nA group administrator can delete it after explicit confirmation. Session history is kept.`, {
          message_thread_id: session.threadId,
          reply_markup: { inline_keyboard: [[{ text: '🌳 Delete worktree', callback_data: `wtcleanup:offer:${token}` }]] },
        }), () => this.active(offer));
    } catch (error) {
      if (this.announced.get(session.id) === generation) this.announced.delete(session.id);
      throw error;
    }
    if (!message || !this.active(offer)) return;
    offer.messageId = message.message_id;
    this.offers.set(token, offer);
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
    await this.deps.authorize(offer.session.chatId, ctx.from.id);
    this.requireActive(offer);
    if (!(await this.deps.currentAdmin(ctx))) {
      this.requireActive(offer);
      await ctx.answerCallbackQuery({ text: 'A current group administrator is required.' });
      return;
    }
    this.requireActive(offer);
    if (this.offers.get(token!) !== offer) return;
    // Consume before awaiting any further work so duplicate callbacks cannot replay deletion.
    this.offers.delete(token!);
    if (action === 'cancel') {
      await ctx.answerCallbackQuery();
      this.requireActive(offer);
      await this.edit(offer, `🌳 Worktree deletion cancelled.\n${offer.target.path}`);
      return;
    }
    if (action === 'offer') {
      await assertWorktreeSessionSafety(this.deps.config, this.deps.store, offer.session, offer.target);
      this.requireActive(offer);
      const current = await this.deps.runtime.inspectWorktree(offer.session);
      this.requireActive(offer);
      if (!current || JSON.stringify(current) !== JSON.stringify(offer.target)) throw new Error('Worktree identity changed before confirmation');
      const confirmation = randomBytes(16).toString('base64url');
      const bound = { ...offer, adminId: ctx.from.id };
      await ctx.answerCallbackQuery();
      this.requireActive(offer);
      await this.edit(bound, `🌳 Permanently delete this entire Git worktree directory?\n${offer.target.path}\n\nThis deletion is irreversible. Git will refuse dirty or locked worktrees. Session history will remain.`, [
        [{ text: '🌳 Confirm deletion', callback_data: `wtcleanup:confirm:${confirmation}` }],
        [{ text: 'Cancel', callback_data: `wtcleanup:cancel:${confirmation}` }],
      ]);
      this.requireActive(offer);
      this.offers.set(confirmation, bound);
      return;
    }
    await ctx.answerCallbackQuery();
    this.requireActive(offer);
    const safetyRevision = () => JSON.stringify({
      config: [this.deps.config.dataDir, this.deps.config.configPath, this.deps.config.instances],
      sessions: this.deps.store.listSessions().map(session => [session.id, session.cwd]),
    });
    let checkedSafety: string | undefined;
    const assertCurrent = () => {
      this.requireActive(offer);
      if (checkedSafety !== undefined && checkedSafety !== safetyRevision()) throw new Error('Session directories or configuration changed before worktree deletion.');
    };
    const beforeMutation = async () => {
      assertCurrent();
      await this.deps.authorize(offer.session.chatId, offer.adminId!);
      assertCurrent();
      if (!(await this.deps.currentAdmin(ctx))) throw new Error('Administrator access changed before worktree deletion.');
      assertCurrent();
      checkedSafety = safetyRevision();
      await assertWorktreeSessionSafety(this.deps.config, this.deps.store, offer.session, offer.target);
      assertCurrent();
    };
    await this.deps.runtime.deleteWorktree(offer.session, offer.target, { assertCurrent, beforeMutation });
    if (this.active(offer)) await this.edit(offer, `🌳 Deleted Git worktree:\n${offer.target.path}\n\nSession history has been kept. Reopening this topic will not recreate the directory.`);
  }

  private async edit(offer: CleanupOffer, text: string, inline_keyboard: { text: string; callback_data: string }[][] = []): Promise<void> {
    await this.deps.delivery.run(offer.session.chatId, () => this.deps.bot.api.editMessageText(
      offer.session.chatId, offer.messageId, text, { reply_markup: { inline_keyboard } },
    ), () => this.active(offer));
  }
}
