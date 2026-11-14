import type { Bot, Context } from 'grammy';
import type { PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptExtension } from '../telegram-commands.js';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, opendirSync, realpathSync } from 'node:fs';
import { configWritable, findInstance, readConfig, refreshTermination, writeConfig } from '../config.js';
import { isActiveMember, isAdministrator } from '../auth.js';
import { contextDestination, replyTo, sendTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import type { CapacityRequest } from './types.js';

export interface CapacityDependencies {
  options: Pick<BotOptions, 'config' | 'store' | 'runtime' | 'configWritable'>;
  bot: Bot<Context>;
  id(): number;
  stopped(): boolean;
  epoch(): number;
  currentAdmin(ctx: Context): Promise<boolean>;
  authorize(chatId: number, userId: number): Promise<void>;
  sessionAssigned(session: TopicSession): boolean;
  assignedId(chatId: number): number;
  localCliCommand(): string;
  folderSettings(chatId: number): {instanceId: number; defaultDir: string; options: string[]};
  listen(session: TopicSession): Promise<void>;
  sendInitial(session: TopicSession): Promise<void>;
  routePrompt(ctx: Context, content: PromptContent, session?: TopicSession, extensions?: readonly PromptExtension[], worktree?: boolean, skills?: {names:string[];topicSkills:string[]}, cwd?: string): Promise<void>;
}

export class CapacityAdmission {
  private readonly capacityRequests = new Map<string, CapacityRequest>();
  constructor(private readonly deps: CapacityDependencies) {}
  clear(): void { this.capacityRequests.clear(); }
  invalidateSession(id: string): void {
    for (const [token, request] of this.capacityRequests) if (request.sessionId === id) this.capacityRequests.delete(token);
  }
  pruneExpired(): void {
    for (const [token, request] of this.capacityRequests) if (request.expires <= Date.now()) this.capacityRequests.delete(token);
  }
  set(token: string, request: CapacityRequest): void { this.capacityRequests.set(token, request); }
  delete(token: string): void { this.capacityRequests.delete(token); }
  async requestCapacity(session: TopicSession, limit: number): Promise<void> {
    if (!this.deps.sessionAssigned(session)) return;
    if (!(this.deps.options.configWritable?.() ?? configWritable(this.deps.options.config.configPath))) {
      const command = `${this.deps.localCliCommand()} setup`;
      await sendTo(this.deps.bot.api, topicDestination(session.chatId, session.threadId), `OMP session limit reached (${limit}). Configuration is read-only; ask the local operator to change its source or permissions, then run:\n${command}`);
      return;
    }
    const now = Date.now();
    for (const [token, request] of this.capacityRequests) {
      if (request.expires <= now || (request.sessionId === session.id && request.limit !== limit)) this.capacityRequests.delete(token);
      else if (request.sessionId === session.id) return;
    }
    const token = randomBytes(16).toString('base64url');
    const message = await sendTo(this.deps.bot.api, topicDestination(session.chatId, session.threadId),
      `OMP session limit reached (${limit}). Increase the shared configured limit from ${limit} to ${limit * 2}? Confirmation by a group administrator is required. Approval saves the configuration, reconnects this topic and submits any pending initial task. Other instructions must be resent. This request expires in 5 minutes.`,
      { reply_markup: { inline_keyboard: [[
        { text: `Confirm ${limit} → ${limit * 2}`, callback_data: `capacity:approve:${token}` },
        { text: 'Cancel', callback_data: `capacity:cancel:${token}` },
      ]] } });
    this.capacityRequests.set(token, {sessionId:session.id,chatId:session.chatId,threadId:session.threadId,messageId:message.message_id,limit,expires:now+300000});
  }
  async confirmCapacity(ctx: Context, action: string, token: string): Promise<void> {
    const request = this.capacityRequests.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!request || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== request.chatId || message.message_id !== request.messageId ||
        (('message_thread_id' in message ? message.message_thread_id : undefined) ?? 1) !== request.threadId ||
        !('from' in message) || message.from?.id !== this.deps.id() ||
        'forward_origin' in message || 'forward_date' in message) return;
    if (request.expires <= Date.now()) {
      this.capacityRequests.delete(token);
      await replyTo(ctx, contextDestination(ctx), 'This capacity request expired. Send a prompt in the topic to request another confirmation.');
      return;
    }
    if (!(await this.deps.currentAdmin(ctx))) {
      await ctx.answerCallbackQuery('Only a current group administrator can confirm or cancel a capacity increase.');
      return;
    }
    await this.deps.authorize(request.chatId,ctx.from!.id);
    if (this.capacityRequests.get(token) !== request) return;
    // Native startup/worktree setup can outlive the callback query.
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp (Client::process_answer_callback_query_query)
    await ctx.answerCallbackQuery();
    this.capacityRequests.delete(token);
    if (action === 'cancel') {
      await replyTo(ctx, contextDestination(ctx), 'Capacity increase cancelled. The session limit is unchanged.');
      return;
    }
    if (request.command) {
      if (this.deps.stopped() || refreshTermination(this.deps.options.config)) return;
      const command = request.command;
      const session = request.sessionId ? this.deps.options.store.getSession(request.sessionId) : undefined;
      if (request.sessionId && (!session || session.status !== 'open' || !this.deps.sessionAssigned(session) ||
          this.deps.options.store.getSessionGeneration(session.id) !== command.generation)) return;
      await this.deps.authorize(request.chatId, command.source.from!.id);
      if (!(await this.deps.currentAdmin(command.source))) return;
      const approver = await this.deps.bot.api.getChatMember(request.chatId, ctx.from!.id);
      if (!isActiveMember(approver) || !isAdministrator(approver)) return;
      if (command.epoch !== this.deps.epoch() || this.deps.stopped() || refreshTermination(this.deps.options.config)) return;
      if (command.folderFingerprint && command.folderFingerprint !== JSON.stringify(this.deps.folderSettings(request.chatId))) return;
      if (command.cwd !== undefined) {
        opendirSync(command.cwd).closeSync();
        accessSync(command.cwd,constants.R_OK | constants.X_OK);
        if (realpathSync(command.cwd) !== command.cwd) throw new Error('Managed working directory identity changed');
      }
      const persisted = readConfig(this.deps.options.config.configPath);
      if (findInstance(persisted, this.deps.id(), request.chatId)?.instance.id !== command.instanceId ||
          this.deps.assignedId(request.chatId) !== command.instanceId) return;
      if (!(this.deps.options.configWritable?.() ?? configWritable(this.deps.options.config.configPath))) return;
      if (persisted.omp.maxSessions !== request.limit || this.deps.options.runtime.getSessionLimit() !== request.limit) return;
      writeConfig({...persisted, omp:{...persisted.omp,maxSessions:request.limit * 2}});
      this.deps.options.config.omp.maxSessions = request.limit * 2;
      if (!this.deps.options.runtime.increaseSessionLimit(request.limit)) return;
      await this.deps.routePrompt(command.source, command.content, session, command.extensions, command.worktree, command.skills, command.cwd);
      return;
    }
    const session = this.deps.options.store.getSession(request.sessionId);
    if (!session || !this.deps.sessionAssigned(session) || session.status !== 'open' || session.chatId !== request.chatId || session.threadId !== request.threadId) return;
    if (!(this.deps.options.configWritable?.() ?? configWritable(this.deps.options.config.configPath))) {
      const command = `${this.deps.localCliCommand()} setup`;
      await replyTo(ctx, contextDestination(ctx), `Configuration is read-only. The session limit is unchanged. Ask the local operator to change its source or permissions, then run:\n${command}`);
      return;
    }
    const member = await this.deps.bot.api.getChatMember(request.chatId, ctx.from!.id);
    const persisted = readConfig(this.deps.options.config.configPath);
    const assigned = findInstance(persisted, this.deps.id(), request.chatId);
    if (!isActiveMember(member) || !assigned ||
        assigned.instance.id !== session.instanceId || !isAdministrator(member)) {
      await replyTo(ctx, contextDestination(ctx), 'The configured instance assignment or administrator access changed. The session limit is unchanged.');
      return;
    }
    if (this.deps.options.runtime.getSessionLimit() !== request.limit || persisted.omp.maxSessions !== request.limit) {
      await replyTo(ctx, contextDestination(ctx), 'The session limit changed. This confirmation is stale; send a prompt to request another confirmation if needed.');
      return;
    }
    writeConfig({ ...persisted, omp: { ...persisted.omp, maxSessions: request.limit * 2 } });
    this.deps.options.config.omp.maxSessions = request.limit * 2;
    this.deps.options.runtime.increaseSessionLimit(request.limit);
    await replyTo(ctx, contextDestination(ctx), `Configured session limit increased from ${request.limit} to ${request.limit * 2}. Reconnecting this topic.`)
      .catch(error => console.warn(`Could not deliver session capacity increase notice (${session.id}).`, error));
    if (this.deps.options.store.hasPendingInitialTask(session.id)) await this.deps.sendInitial(session);
    else await this.deps.listen(session);
  }
}
