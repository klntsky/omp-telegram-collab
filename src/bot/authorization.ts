import { GrammyError, type Bot, type Context } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import type { Store } from '../store.js';
import type { Omp } from '../omp.js';
import { AuthorizationUnavailableError, isActiveMember, isAdministrator } from '../auth.js';
import { findInstance, readConfig, refreshTermination } from '../config.js';
import { withCancellation } from '../cancellation.js';
import { contextDestination, replyTo } from '../telegram-destination.js';
import { AuthorizationDeniedError } from './types.js';
import { help, terminationMessage } from './commands.js';

interface AuthorizationDependencies {
  bot: Bot<Context>; config: AppConfig; store: Store; runtime: Omp;
  botId(): number; stopped(): boolean; signal: AbortSignal;
}

export class BotAuthorization {
  constructor(private readonly deps: AuthorizationDependencies) {}

async authorize(chatId: number, userId: number, statusOnly = false): Promise<void> {
    await this.authorizeMember(chatId, userId, statusOnly);
  }

async authorizeSession(session: TopicSession, userId: number, signal?: AbortSignal): Promise<boolean> {
    const member = await this.authorizeMember(session.chatId, userId, false, signal);
    signal?.throwIfAborted();
    this.requireSessionAssignment(session);
    return isAdministrator(member);
  }

  private async authorizeMember(chatId: number, userId: number, statusOnly = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.deps.stopped()) throw this.deps.signal.reason;
    if (refreshTermination(this.deps.config) && !statusOnly) throw new Error(terminationMessage);
    const instanceId = this.assignedId(chatId);
    if (!this.deps.store.isEnrolled(this.deps.botId(), chatId)) throw new Error('Group not enrolled');
    const deadline = new AbortController();
    const timeoutReason = new DOMException('Telegram authorization lookup timed out after 10 seconds', 'TimeoutError');
    const cancellation = AbortSignal.any(signal ? [signal, this.deps.signal, deadline.signal] : [this.deps.signal, deadline.signal]);
    const telegram = new TelegramAbortController();
    const cancelTelegram = () => telegram.abort();
    cancellation.addEventListener('abort', cancelTelegram, {once:true});
    const timeout = setTimeout(() => deadline.abort(timeoutReason), 10000);
    try {
      cancellation.throwIfAborted();
      const [chat, user, bot] = await withCancellation(Promise.all([
        this.deps.bot.api.getChat(chatId, telegram.signal),
        this.deps.bot.api.getChatMember(chatId, userId, telegram.signal),
        this.deps.bot.api.getChatMember(chatId, this.deps.botId(), telegram.signal),
      ]), cancellation).catch(error => {
        if (cancellation.aborted && cancellation.reason !== timeoutReason) throw cancellation.reason;
        if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 && error.error_code !== 429) throw error;
        throw new AuthorizationUnavailableError(error);
      });
      cancellation.throwIfAborted();
      if (refreshTermination(this.deps.config) && !statusOnly) throw new Error(terminationMessage);
      if (this.assignedId(chatId) !== instanceId) throw new Error('The group instance assignment changed');
      if (!isActiveMember(user)) throw new AuthorizationDeniedError('Group access denied');
      if (chat.type !== 'supergroup' || (!statusOnly && (!chat.is_forum || bot.status !== 'administrator' || !bot.can_manage_topics))) throw new Error('Group access denied');
      if (this.deps.stopped()) throw this.deps.signal.reason;
      if (!this.deps.store.isEnrolled(this.deps.botId(), chatId)) throw new Error('Group not enrolled');
      return user;
    } finally {
      clearTimeout(timeout);
      cancellation.removeEventListener('abort', cancelTelegram);
      telegram.abort();
    }
  }

async ready(chatId: number): Promise<boolean> {
    const [chat, member] = await Promise.all([this.deps.bot.api.getChat(chatId), this.deps.bot.api.getChatMember(chatId, this.deps.botId())]);
    return chat.type === 'supergroup' && chat.is_forum === true && member.status === 'administrator' && member.can_manage_topics === true && member.can_pin_messages === true;
  }

assignedId(chatId: number): number {
    const assigned = findInstance(this.deps.config, this.deps.botId(), chatId);
    if (!assigned) throw new Error('This group has no configured instance assignment');
    return assigned.instance.id;
  }

assignedCwd(chatId: number): string {
    const assigned = findInstance(this.deps.config, this.deps.botId(), chatId);
    if (!assigned) throw new Error('This group has no configured instance assignment');
    return assigned.instance.defaultDir;
  }

sessionAssigned(session: TopicSession): boolean {
    if (session.botId !== this.deps.botId() || !this.deps.store.isEnrolled(this.deps.botId(), session.chatId)) return false;
    if (this.deps.store.getTopicKind(session) === 'detached') return false;
    const stored = this.deps.store.getSession(session.id);
    if (!stored || stored.status === 'detached' || stored.botId !== session.botId || stored.chatId !== session.chatId || stored.threadId !== session.threadId || stored.instanceId !== session.instanceId || !session.instanceId) return false;
    try { return this.assignedId(session.chatId) === session.instanceId; } catch { return false; }
  }

requireSessionAssignment(session: TopicSession): void {
    if (this.deps.stopped()) throw this.deps.signal.reason;
    if (refreshTermination(this.deps.config)) throw new Error(terminationMessage);
    if (!this.sessionAssigned(session)) throw new Error('This session is not assigned to its configured instance path');
  }

allMessagesArePrompts(chatId: number): boolean {
    return findInstance(this.deps.config, this.deps.botId(), chatId)?.instance.chats
      .find(chat => chat.botId === this.deps.botId() && chat.chatId === chatId)?.all_messages_are_prompts !== false;
  }

usersCanProposePrompts(chatId: number): boolean {
    return findInstance(this.deps.config, this.deps.botId(), chatId)?.instance.chats
      .find(chat => chat.botId === this.deps.botId() && chat.chatId === chatId)?.users_can_propose_prompts === true;
  }

createsTopicWorktrees(chatId: number): boolean {
    return findInstance(this.deps.config, this.deps.botId(), chatId)?.instance.chats
      .find(chat => chat.botId === this.deps.botId() && chat.chatId === chatId)?.create_topic_worktrees === true;
  }

promptHelp(chatId: number): string {
    const input = this.allMessagesArePrompts(chatId)
      ? 'Text messages in a session topic are treated as prompts.'
      : 'Use /p <prompt> or reply to my messages in a session topic. Ordinary messages and mentions are ignored.';
    return `${input}\nIn General, /p works like /new: include the task in the command or reply to a message with text.\n${this.usersCanProposePrompts(chatId)
      ? 'Non-admin prompts require approval by a group administrator.'
      : 'Only group administrators can send prompts. Other members’ messages are ignored.'}`;
  }

commandHelp(chatId: number, admin: boolean): string {
    return help({ promptHelp: this.promptHelp(chatId), miniApp: Boolean(this.deps.config.publicUrl), admin });
  }

async currentAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.from || ctx.from.is_bot || ctx.chat?.type !== 'supergroup') return false;
    return isAdministrator(await this.deps.bot.api.getChatMember(ctx.chat.id, ctx.from.id));
  }

async listAdmins(ctx: Context): Promise<void> {
    const destination = contextDestination(ctx);
    const instanceId = this.assignedId(destination.chatId);
    const roster = await this.deps.bot.api.getChatAdministrators(destination.chatId);
    const lines = ['Group administrators:', ...roster.filter(isAdministrator).map(member =>
      `${member.status === 'creator' ? 'Owner' : 'Administrator'}: ${member.user.username ? `@${member.user.username}` : `${member.user.first_name} (User ${member.user.id})`}`)];
    let chunk = '';
    const deliver = async () => {
      await this.authorize(destination.chatId, ctx.from!.id);
      if (this.assignedId(destination.chatId) !== instanceId ||
          findInstance(readConfig(this.deps.config.configPath), this.deps.botId(), destination.chatId)?.instance.id !== instanceId) throw new Error('The group instance assignment changed');
      await replyTo(ctx, destination, chunk);
    };
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 3800) { await deliver(); chunk = ''; }
      chunk += `${chunk ? '\n' : ''}${line}`;
    }
    if (chunk) await deliver();
  }
}
