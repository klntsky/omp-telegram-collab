import path from 'node:path';
import type { Bot, Context } from 'grammy';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import type { Omp } from '../omp.js';
import type { Store } from '../store.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { refreshTermination } from '../config.js';
import { decodeWorktreeCleanupCallback, encodeWorktreeCleanupCallback } from './worktree-cleanup-callback.js';
import { codeHtml } from '../telegram-html.js';

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

export class WorktreeCleanup {
  private readonly busy = new Set<string>();
  constructor(private readonly deps: CleanupDependencies) {}

  private active(session: TopicSession): boolean {
    const stored = this.deps.store.getSession(session.id);
    return !this.deps.stopped() && !refreshTermination(this.deps.config) &&
      session.botId === this.deps.botId() && this.deps.sessionAssigned(session) &&
      stored?.status === 'closed' && stored.cwd === session.cwd && stored.runtime.kind === 'managed';
  }

  private buttons(session: TopicSession) {
    return [[{ text: '🌳 Delete worktree', callback_data: encodeWorktreeCleanupCallback({ action: 'offer', sessionId: session.id }) }]];
  }

  async offer(source: TopicSession): Promise<void> {
    const session = this.deps.store.getSession(source.id);
    if (!session || session.runtime.kind !== 'managed' || !this.active(session)) return;
    const target = await this.deps.runtime.inspectWorktree(session);
    if (!target) return;
    // Manage Topics permits outgoing messages in closed topics. Do not reopen to send.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp (can_send_message_to_forum_topic)
    const text = `🌳 This topic used this Git worktree:\n${codeHtml(target.path)}\n\nA group administrator can delete it after explicit confirmation. Session history is kept.`;
    await this.deps.delivery.run(session.chatId, () => this.deps.bot.api.sendMessage(session.chatId,
      text, {
        parse_mode: 'HTML', message_thread_id: session.threadId, reply_markup: { inline_keyboard: this.buttons(session) },
      }), () => this.active(session));
  }

  async callback(ctx: Context, data: string): Promise<void> {
    const command = decodeWorktreeCleanupCallback(data);
    const message = ctx.callbackQuery?.message;
    if (!command || !message || !('from' in message) || message.from?.id !== this.deps.botId() ||
        !ctx.from || ctx.from.is_bot || ctx.chat?.type !== 'supergroup' ||
        'forward_origin' in message || 'forward_date' in message) return;
    const session = this.deps.store.getSession(command.sessionId);
    if (!session || session.botId !== this.deps.botId() || message.chat.id !== session.chatId ||
        message.message_thread_id !== session.threadId || !this.active(session)) {
      await ctx.answerCallbackQuery({ text: 'Close the assigned managed topic before deleting its worktree.' });
      return;
    }
    // Callback messages are enqueue-time snapshots, not live Telegram button state.
    // Durable confirmation identity below is authoritative after cancellation/restart.
    // Client::add_update_impl serializes JsonCallbackQuery before queueing:
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
    if (command.action === 'offer' && !message.reply_markup?.inline_keyboard.some(row => row.some(button => 'callback_data' in button && button.callback_data === data))) {
      await ctx.answerCallbackQuery({ text: 'Use the current buttons on this message.' });
      return;
    }
    const confirmations = this.deps.store.worktreeConfirmations;
    const approval = command.action === 'offer' ? undefined
      : confirmations.get(session.id, message.message_id, command.token);
    if (command.action !== 'offer' && !approval) {
      await ctx.answerCallbackQuery({ text: 'Use the current buttons on this message.' });
      return;
    }
    if (approval && approval.adminId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Only the administrator who requested confirmation can use it.' });
      return;
    }
    if (this.busy.has(session.id)) {
      await ctx.answerCallbackQuery({ text: 'Worktree cleanup is already being processed.' });
      return;
    }
    this.busy.add(session.id);
    try {
      if (!(await this.deps.authorizeSession(session, ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'A current group administrator is required.' });
        return;
      }
      if (!this.active(session)) throw new Error('Worktree cleanup requires the assigned topic to remain closed.');
      const target = await this.deps.runtime.inspectWorktree(session);
      if (!target) {
        await ctx.answerCallbackQuery({ text: 'This topic has no removable managed worktree.' });
        return;
      }
      if (!(await this.deps.authorizeSession(session, ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'A current group administrator is required.' });
        return;
      }
      if (!this.active(session)) throw new Error('Worktree cleanup requires the assigned topic to remain closed.');
      if (approval && !confirmations.matches(approval, session, target)) {
        if (command.action !== 'offer') confirmations.invalidate(session.id, command.token);
        await ctx.answerCallbackQuery({ text: 'The worktree changed. Request a new confirmation.' });
        await this.edit(session, message.message_id,
          `🌳 The worktree changed. Confirm the current directory before deleting it:\n${codeHtml(target.path)}`, this.buttons(session));
        return;
      }
      await ctx.answerCallbackQuery();
      if (command.action === 'cancel') {
        confirmations.invalidate(session.id, command.token);
        await this.edit(session, message.message_id, `🌳 Worktree deletion cancelled.\n${codeHtml(target.path)}`, this.buttons(session));
      } else if (command.action === 'offer') {
        const token = confirmations.issue(session, message.message_id, ctx.from.id, target);
        const nextApproval = { sessionId: session.id, token };
        await this.edit(session, message.message_id,
          `🌳 Permanently delete this entire Git worktree directory?\n${codeHtml(target.path)}\n\nThis deletion is irreversible. Git will refuse dirty or locked worktrees. Session history will remain.`, [
            [{ text: '🌳 Confirm deletion', callback_data: encodeWorktreeCleanupCallback({ action: 'confirm', ...nextApproval }) }],
            [{ text: '❌ Cancel', callback_data: encodeWorktreeCleanupCallback({ action: 'cancel', ...nextApproval }) }],
          ]);
      } else {
        await this.deps.runtime.deleteWorktree(session, target, async () => {
          if (!(await this.deps.authorizeSession(session, ctx.from!.id))) throw new Error('Administrator access changed before worktree deletion.');
          if (!this.active(session)) throw new Error('Worktree cleanup requires the assigned topic to remain closed.');
          for (const other of this.deps.store.listSessions()) {
            if (other.id !== session.id && (contains(target.path, other.cwd) || contains(other.cwd, target.path))) {
              throw new Error(`Another session uses this worktree: ${other.id}`);
            }
          }
        });
        confirmations.invalidate(session.id, command.token);
        await this.edit(session, message.message_id,
          `🌳 Deleted Git worktree:\n${codeHtml(target.path)}\n\nSession history has been kept. Reopening this topic will not recreate the directory.`);
      }
    } finally {
      this.busy.delete(session.id);
    }
  }

  private async edit(session: TopicSession, messageId: number, text: string, inline_keyboard: { text: string; callback_data: string }[][] = []): Promise<void> {
    await this.deps.delivery.run(session.chatId, () => this.deps.bot.api.editMessageText(
      session.chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard } },
    ), () => this.active(session));
  }
}
