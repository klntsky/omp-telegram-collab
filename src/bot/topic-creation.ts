import type { Context, Bot } from 'grammy';
import type { TopicSession, PromptContent, HostBinding } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import { contextDestination, replyTo, sendTo, forwardTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { accessSync, constants, opendirSync, realpathSync } from 'node:fs';
import { refreshTermination } from '../config.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { PendingSkillKey } from '../store.js';
import type { TopicActivity } from './types.js';
export interface TopicCreationDependencies {
  options: BotOptions;
  bot: Bot<Context>;
  id: number;
  readonly admissionEpoch: number;
  readonly stopped: boolean;
  authorize(chatId: number, userId: number): Promise<unknown>;
  currentAdmin(ctx: Context): Promise<boolean>;
  folderSettings(chatId: number): unknown;
  assignedId(chatId: number): number;
  assignedCwd(chatId: number): string;
  chooseFolder(source: Context, authority: Context | undefined, resume: (cwd: string, authority: Context) => Promise<void>): Promise<boolean>;
  getIconIds(): Promise<Record<'running' | 'finished', string>>;
  createsTopicWorktrees(chatId: number): boolean;
  createTopicWorktree(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<void>;
  requireSessionAssignment(session: TopicSession): void;
  preparePrompt(ctx: Context, session: TopicSession, extensions: readonly PromptExtension[], authority: Context): Promise<void>;
  skillKey(ctx: Context): PendingSkillKey;
  defaultNewTopicSkill(chatId: number): string | undefined;
  albumContexts(ctx: Context): readonly Context[];
  announce(session: TopicSession): Promise<void>;
  setTopicStatus(session: TopicSession, activity: TopicActivity): Promise<void>;
  listen(session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>): Promise<unknown>;
  sendInitial(session: TopicSession): Promise<void>;
}

export class TopicCreation {
  constructor(private readonly dependencies: TopicCreationDependencies) {}
  async newSession(
    ctx: Context,
    task?: PromptContent,
    attached?: { hostId: string; sessionId: string; instanceId: number; cwd: string },
    name?: string,
    accepted?: () => void,
    worktree = false,
    authority = ctx,
    extensions: readonly PromptExtension[] = [],
    reservation?: {bind(id: string): void},
    cwd?: string,
    proposedSkills?: {names:string[];topicSkill?:string},
  ): Promise<void> {
    await this.dependencies.authorize(ctx.chat!.id, ctx.from!.id);
    const folderFingerprint = JSON.stringify(this.dependencies.folderSettings(ctx.chat!.id));
    const epoch = this.dependencies.admissionEpoch;
    const instanceId = this.dependencies.assignedId(ctx.chat!.id);
    if (attached && attached.instanceId !== instanceId)
      throw new Error('The group instance assignment changed');
    if (worktree && attached) throw new Error('Attached sessions cannot create managed worktrees');
    if (this.dependencies.assignedId(ctx.chat!.id) !== instanceId)
      throw new Error('The group instance assignment changed');
    if (!attached && cwd === undefined && await this.dependencies.chooseFolder(ctx,authority,selected =>
      this.newSession(ctx,task,attached,name,accepted,worktree,authority,extensions,undefined,selected,proposedSkills))) return;
    if (!attached && !worktree && proposedSkills) {
      const names = [...new Set([...proposedSkills.names,...(proposedSkills.topicSkill ? [proposedSkills.topicSkill] : [])])];
      if (names.length) {
        const available = await this.dependencies.options.runtime.listSkills(instanceId, undefined, undefined, cwd);
        const missing = names.filter(name => !available.some(skill => skill.name === name));
        if (missing.length) throw new Error(`Skills are no longer available: ${missing.join(', ')}`);
      }
    }
    const title =
      (name ?? task?.text.replace(/(?:^|\s)\/skill:[^\s]+/g, ' ') ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 128) || 'OMP session';
    const initialIcon =
      task !== undefined && !worktree ? (await this.dependencies.getIconIds()).running : undefined;
    if (!(await this.dependencies.currentAdmin(authority)))
      throw new Error('Administrator access changed before topic creation.');
    if (this.dependencies.stopped || refreshTermination(this.dependencies.options.config)) throw new Error('The service is stopping');
    if (epoch !== this.dependencies.admissionEpoch || folderFingerprint !== JSON.stringify(this.dependencies.folderSettings(ctx.chat!.id)))
      throw new Error('Folder settings changed before topic creation. Send the command again.');
    if (cwd !== undefined) {
      opendirSync(cwd).closeSync();
      accessSync(cwd,constants.R_OK | constants.X_OK);
      if (realpathSync(cwd) !== cwd) throw new Error('Managed working directory identity changed');
    }
    const topic = await this.dependencies.bot.api.createForumTopic(
      ctx.chat!.id,
      title,
      initialIcon ? { icon_custom_emoji_id: initialIcon } : {},
    );
    if (this.dependencies.assignedId(ctx.chat!.id) !== instanceId)
      throw new Error('The group instance assignment changed');
    if (epoch !== this.dependencies.admissionEpoch || folderFingerprint !== JSON.stringify(this.dependencies.folderSettings(ctx.chat!.id)))
      throw new Error('Folder settings changed during topic creation. Send the command again.');
    const automaticWorktree = !attached && !worktree && !extensions.some(extension => extension.kind === 'worktree') && this.dependencies.createsTopicWorktrees(ctx.chat!.id);
    const session = this.dependencies.options.store.createSession(
      { botId: this.dependencies.id, chatId: ctx.chat!.id, threadId: topic.message_thread_id, instanceId, cwd: attached?.cwd ?? cwd ?? this.dependencies.assignedCwd(ctx.chat!.id) },
      title,
      attached
        ? { kind: 'attached', instanceId: attached.hostId, sessionId: attached.sessionId }
        : { kind: 'managed' },
      attached || worktree || automaticWorktree || extensions.length ? undefined : task,
      ctx.from!.id,
      authority.from!.id,
    );
    this.dependencies.options.store.beginInitialTaskPreparation(session.id);
    try {
      reservation?.bind(session.id);
      if (automaticWorktree) {
        await this.dependencies.authorize(ctx.chat!.id, ctx.from!.id);
        if (!(await this.dependencies.currentAdmin(authority)))
          throw new Error('Administrator access changed before worktree creation.');
        await this.dependencies.createTopicWorktree(session);
        if (task !== undefined && !extensions.length) {
          await this.dependencies.authorize(ctx.chat!.id, ctx.from!.id);
          if (!(await this.dependencies.currentAdmin(authority)))
            throw new Error('Administrator access changed before initial task submission.');
          this.dependencies.requireSessionAssignment(session);
          this.dependencies.options.store.setInitialTask(session.id, task, ctx.from!.id, authority.from!.id);
        }
      }
      if (extensions.length) {
        try {
          await this.dependencies.preparePrompt(ctx, session, extensions, authority);
        } catch (error) {
          await replyTo(ctx, contextDestination(ctx), `Topic created: https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`).catch(deliveryError => {
            console.error('Could not deliver the created topic link after prompt preparation failed.', deliveryError);
          });
          throw error;
        }
        if (task !== undefined) {
          await this.dependencies.authorize(ctx.chat!.id, ctx.from!.id);
          if (!(await this.dependencies.currentAdmin(authority))) throw new Error('Administrator access changed before initial task submission.');
          this.dependencies.requireSessionAssignment(session);
          this.dependencies.options.store.setInitialTask(session.id, task, ctx.from!.id, authority.from!.id);
        }
      }
      if (worktree) {
        const text = await this.dependencies.options.runtime.worktree(session, task?.text || undefined);
        this.dependencies.options.store.setSessionCwd(session.id, session.cwd);
        task = undefined;
        await replyTo(ctx, topicDestination(session.chatId, session.threadId), `🌳 ${text}`);
      }
      if (worktree) {
        const sourceKey = this.dependencies.skillKey(ctx);
        const destinationKey = {
          ...sourceKey,
          destination: topicDestination(session.chatId, session.threadId),
        };
        for (const skill of this.dependencies.options.store.getPendingSkills(sourceKey))
          this.dependencies.options.store.addPendingSkill(destinationKey, skill);
        this.dependencies.options.store.clearPendingSkills(sourceKey);
        const defaultSkill = this.dependencies.defaultNewTopicSkill(ctx.chat!.id);
        if (defaultSkill) this.dependencies.options.store.setNewTopicSkill(session.id, defaultSkill);
      }
      accepted?.();
      if (task !== undefined && ctx.message)
        this.dependencies.options.store.setInitialMessage(session.id, ctx.message.message_id);
      if (task !== undefined && ctx.message)
        for (const original of this.dependencies.albumContexts(ctx))
          if (original.message && original.message.message_id !== ctx.message.message_id)
            this.dependencies.options.store.recordPromptMessageAlias(session.id, ctx.message.message_id, original.message.message_id);
      await replyTo(
        ctx,
        contextDestination(ctx),
        `Topic created: https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`,
        {
          reply_parameters: {
            message_id: ctx.message!.message_id,
            allow_sending_without_reply: true,
          },
          link_preview_options: { is_disabled: true },
        },
      );
      await this.dependencies.announce(session);
      const source = ctx.message;
      if (task !== undefined && source?.reply_to_message) {
        await forwardTo(
          this.dependencies.bot.api,
          topicDestination(session.chatId, session.threadId),
          ctx.chat!.id,
          source.reply_to_message.message_id,
        );
      }
      if (task !== undefined)
        for (const original of this.dependencies.albumContexts(ctx)) {
          if (!original.message) continue;
          const forwarded = await forwardTo(
            this.dependencies.bot.api,
            topicDestination(session.chatId, session.threadId),
            ctx.chat!.id,
            original.message.message_id,
          );
          this.dependencies.options.store.recordPromptMessageAlias(session.id, source!.message_id, forwarded.message_id);
        }
      await this.dependencies.setTopicStatus(session, task !== undefined ? 'running' : 'unknown');
      await this.dependencies.listen(session);
    } finally {
      this.dependencies.options.store.finishInitialTaskPreparation(session.id);
    }
    await this.dependencies.sendInitial(session);
  }
}
