import type { Bot, Context } from 'grammy';
import type { PendingPromptContent, PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptExtension } from '../telegram-commands.js';
import { randomBytes } from 'node:crypto';
import type { PendingSkillKey } from '../store.js';
import { configWritable, findInstance, refreshTermination } from '../config.js';
import { SessionCapacityError } from '../runtime/types.js';
import { contextDestination, replyTo } from '../telegram-destination.js';
import { sameTopicDestination } from '../../shared/topic-destination.js';
import type { Listener, PresetPanel, PromptProposal } from './types.js';
import type { CapacityAdmission } from './capacity-admission.js';

export interface PromptAdmissionDependencies {
  options: Pick<BotOptions, 'config' | 'store' | 'runtime' | 'configWritable'>;
  id(): number;
  stopped(): boolean;
  capacity: CapacityAdmission;
  currentAdmin(ctx: Context): Promise<boolean>;
  authorize(chatId: number, userId: number): Promise<void>;
  sessionAssigned(session: TopicSession): boolean;
  requireSessionAssignment(session: TopicSession): void;
  assignedId(chatId: number): number;
  assignedCwd(chatId: number): string;
  usersCanProposePrompts(chatId: number): boolean;
  allMessagesArePrompts(chatId: number): boolean;
  folderSettings(chatId: number): {instanceId: number; defaultDir: string; options: string[]};
  chooseFolder(source: Context, authority: Context | undefined, resume: (cwd: string, authority: Context) => Promise<void>, active?: () => boolean): Promise<boolean>;
  skillKey(ctx: Context): PendingSkillKey;
  defaultNewTopicSkill(chatId: number): string | undefined;
  renderPresetPanel(panel: PresetPanel): Promise<void>;
  replyPresetText(ctx: Context, text: string): Promise<void>;
  preparePrompt(ctx: Context, session: TopicSession, extensions: readonly PromptExtension[], authority?: Context): Promise<void>;
  uploadDocuments(ctx: Context, session: TopicSession, content: PendingPromptContent, authority: Context): Promise<PromptContent>;
  newSession(ctx: Context, task?: PendingPromptContent, attached?: {hostId:string;sessionId:string;instanceId:number;cwd:string}, name?: string, accepted?: () => void, worktree?: boolean, authority?: Context, extensions?: readonly PromptExtension[], reservation?: {bind(id:string):void}, cwd?: string, proposedSkills?: {names:string[];topicSkill?:string}): Promise<void>;
  listen(session: TopicSession): Promise<void>;
  listener(sessionId: string): Listener | undefined;
  albumContexts(ctx: Context): readonly Context[];
  sendPrompt(listener: Listener, content: PromptContent, messageId: number, restore?: () => void): void;
}

export class PromptAdmission {
  private admissionEpoch = 0;
  private readonly promptProposals = new Map<string, PromptProposal>();
  constructor(private readonly deps: PromptAdmissionDependencies) {}
  get epoch(): number { return this.admissionEpoch; }
  clear(): void {
    this.deps.capacity.clear();
    this.admissionEpoch++;
    this.promptProposals.clear();
  }
  invalidateProposals(sessionId: string): void {
    for (const [token, proposal] of this.promptProposals) if (proposal.sessionId === sessionId) this.promptProposals.delete(token);
  }
  async routePrompt(ctx: Context, content: PendingPromptContent, session?: TopicSession, extensions: readonly PromptExtension[] = [], worktree = false, frozenSkills?: {names:string[];topicSkill?:string}, cwd?: string): Promise<void> {
    const epoch = this.admissionEpoch;
    const folderFingerprint = !session ? JSON.stringify(this.deps.folderSettings(ctx.chat!.id)) : undefined;
    const generation = session ? this.deps.options.store.getSessionGeneration(session.id) : undefined;
    const instanceId = this.deps.assignedId(ctx.chat!.id);
    const hasTask = !!content.text.trim() || !!content.images?.length || !!content.documents?.length;
    const admin = await this.deps.currentAdmin(ctx);
    if (!admin && !this.deps.usersCanProposePrompts(ctx.chat!.id)) return;
    const preparations = extensions.filter(extension => extension.kind !== 'skill');
    if (preparations.length && !admin) {
      await replyTo(ctx, contextDestination(ctx), 'Prompt preparations require a group administrator.');
      return;
    }
    await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
    if (session) {
      this.deps.requireSessionAssignment(session);
      if (session.status !== 'open') { await replyTo(ctx, contextDestination(ctx), 'This session is archived. Reopen the topic before sending instructions.'); return; }
    }
    if (session?.runtime.kind === 'attached' && preparations.length) throw new Error('Attached sessions cannot run prompt preparations.');
    const skillKey = this.deps.skillKey(ctx);
    const pendingSkills = frozenSkills?.names ?? this.deps.options.store.getPendingSkills(skillKey);
    const topicSkill = frozenSkills ? frozenSkills.topicSkill : worktree ? undefined : session ? this.deps.options.store.getNewTopicSkill(session.id) : this.deps.defaultNewTopicSkill(ctx.chat!.id);
    const originalContent = structuredClone(content);
    const originalExtensions = structuredClone(extensions);
    if (admin && !session && cwd === undefined && await this.deps.chooseFolder(ctx,ctx,selected =>
      this.routePrompt(ctx,originalContent,undefined,originalExtensions,worktree,{names:[...pendingSkills],topicSkill},selected))) return;
    if (!admin && !session && this.deps.folderSettings(ctx.chat!.id).options.length > 1) {
      const selectedSkills = {key:skillKey,names:[...new Set([...pendingSkills,...extensions.flatMap(extension => extension.kind === 'skill' ? [extension.name] : [])])],topicSkill};
      const proposalMode = this.deps.allMessagesArePrompts(ctx.chat!.id);
      await this.deps.chooseFolder(ctx,undefined,async (selected,authority) => {
        if (!this.deps.usersCanProposePrompts(ctx.chat!.id) || this.deps.allMessagesArePrompts(ctx.chat!.id) !== proposalMode)
          throw new Error('This prompt proposal is no longer active.');
        const names = worktree ? [] : [...new Set([...(topicSkill ? [topicSkill] : []),...selectedSkills.names])];
        const approvedContent = names.length ? {...originalContent,text:`${names.map(name => `/skill:${name}`).join(' ')}\n\n${originalContent.text}`} : originalContent;
        await this.deps.newSession(ctx,approvedContent,undefined,undefined,() => this.consumePendingSkills(skillKey,selectedSkills.names),worktree,authority,[],undefined,selected,selectedSkills);
      },() => this.deps.usersCanProposePrompts(ctx.chat!.id) && this.deps.allMessagesArePrompts(ctx.chat!.id) === proposalMode);
      return;
    }
    if (extensions.some(extension => extension.kind === 'model-preset' && extension.name === undefined)) {
      const check = () => {
        if (this.deps.stopped() || refreshTermination(this.deps.options.config) || epoch !== this.admissionEpoch)
          throw new Error('The service is stopping');
        if (this.deps.assignedId(ctx.chat!.id) !== instanceId)
          throw new Error('The group instance assignment changed');
        if (folderFingerprint !== undefined && folderFingerprint !== JSON.stringify(this.deps.folderSettings(ctx.chat!.id)))
          throw new Error('Folder settings changed before execution. Send the command again.');
        if (session) {
          this.deps.requireSessionAssignment(session);
          if (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
              this.deps.options.store.getTopic({botId: this.deps.id(), destination: contextDestination(ctx)})?.id !== session.id ||
              this.deps.options.store.getSession(session.id)?.status !== 'open')
            throw new Error('The session changed before the prompt could run');
        }
      };
      const panel: PresetPanel = {
        token: randomBytes(16).toString('base64url'), chatId: ctx.chat!.id,
        destination: contextDestination(ctx), messageId: 0, instanceId,
        sessionId: session?.id ?? '', generation: generation ?? 0,
        revision: 0, expires: Date.now() + 30 * 60_000, choices: [], listOffset: 0, detailOffset: 0,
        continuation: {
          kind: 'prompt', active: true, source: ctx,
          cwd: cwd ?? session?.cwd ?? this.deps.assignedCwd(ctx.chat!.id),
          check,
          resume: name => this.routePrompt(ctx, originalContent, session,
            originalExtensions.map(extension => extension.kind === 'model-preset' && extension.name === undefined
              ? {...extension, name} : extension),
            worktree, {names: [...pendingSkills], topicSkill}, cwd),
        },
      };
      await this.deps.renderPresetPanel(panel);
      return;
    }
    if (extensions.some(extension => extension.kind === 'model-preset')) {
      const names = await this.deps.options.runtime.availableModelPresets(instanceId, cwd ?? session?.cwd);
      for (const extension of extensions) {
        if (extension.kind === 'model-preset' && (extension.name === undefined || !names.includes(extension.name))) {
          await this.deps.replyPresetText(ctx, `Unknown model preset: ${extension.name}. Available presets: ${names.join(', ') || '(none)'}\nPlease refine your request with an available preset.`);
          return;
        }
      }
    }
    const mentionedSkills = worktree ? [] : [...new Set([...(topicSkill ? [topicSkill] : []), ...pendingSkills, ...extensions.flatMap(extension => extension.kind === 'skill' ? [extension.name] : [])])];
    if (mentionedSkills.length) {
      if (admin || session) {
        const available = await this.deps.options.runtime.listSkills(instanceId, session, undefined, cwd);
        const missing = mentionedSkills.filter(name => !available.some(skill => skill.name === name));
        if (missing.length) throw new Error(`Skills are no longer available: ${missing.map(name => `/skill:${name}`).join(', ')}. Use /skills clear for explicit selections. Restore a missing topic-default skill, or create a new topic after changing the forum default.`);
      }
      content = {...content,text:`${mentionedSkills.map(name => `/skill:${name}`).join(' ')}\n\n${content.text}`};
    }
    if (this.deps.assignedId(ctx.chat!.id) !== instanceId) throw new Error('The group instance assignment changed');
    if (session && (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
        this.deps.options.store.getSession(session.id)?.status !== 'open')) throw new Error('The session changed while downloading the image');
    if (await this.deps.currentAdmin(ctx)) {
      const authorizeExecution = async () => {
        await this.deps.authorize(ctx.chat!.id,ctx.from!.id);
        if (this.deps.stopped() || refreshTermination(this.deps.options.config) || epoch !== this.admissionEpoch) throw new Error('The service is stopping');
        if (!(await this.deps.currentAdmin(ctx)) || this.deps.assignedId(ctx.chat!.id) !== instanceId || this.deps.stopped() || refreshTermination(this.deps.options.config) || epoch !== this.admissionEpoch) throw new Error('Prompt authority or assignment changed before execution.');
        if (folderFingerprint && folderFingerprint !== JSON.stringify(this.deps.folderSettings(ctx.chat!.id)))
          throw new Error('Folder settings changed before execution. Send the command again.');
        if (session && (this.deps.options.store.getSessionGeneration(session.id) !== generation || this.deps.options.store.getSession(session.id)?.status !== 'open')) throw new Error('The session changed before execution.');
      };
      let reservation: {bind(id:string):void;release():void} | undefined;
      if (extensions.length && session?.runtime.kind !== 'attached') {
        try {
          reservation = await this.deps.options.runtime.reserveSession(session?.id, authorizeExecution);
        } catch (error) {
          if (!(error instanceof SessionCapacityError)) throw error;
          if (!(this.deps.options.configWritable?.() ?? configWritable(this.deps.options.config.configPath))) {
            await replyTo(ctx, contextDestination(ctx), `${error.message}\nConfiguration is read-only; ask the local operator to increase the configured capacity.`);
            return;
          }
          const token = randomBytes(16).toString('base64url');
          if (this.deps.stopped() || refreshTermination(this.deps.options.config)) return;
          this.deps.capacity.pruneExpired();
          const message = await replyTo(ctx, contextDestination(ctx), `OMP session limit reached (${error.limit}). Increase shared capacity to ${error.limit * 2} and execute this command?`, {
            reply_markup:{inline_keyboard:[[
              {text:'Approve',callback_data:`capacity:approve:${token}`},
              {text:'Cancel',callback_data:`capacity:cancel:${token}`},
            ]]},
          });
          if (this.deps.stopped() || refreshTermination(this.deps.options.config) || epoch !== this.admissionEpoch ||
              (folderFingerprint !== undefined && folderFingerprint !== JSON.stringify(this.deps.folderSettings(ctx.chat!.id)))) return;
          this.deps.capacity.set(token, {
            sessionId:session?.id ?? '',chatId:ctx.chat!.id,threadId:ctx.message?.message_thread_id ?? 1,
            messageId:message.message_id,limit:error.limit,expires:Date.now()+300000,
            command:{source:ctx,content:originalContent,extensions:structuredClone(extensions),worktree,instanceId,epoch,generation,skills:{names:[...pendingSkills],topicSkill},cwd,folderFingerprint},
          });
          setTimeout(() => this.deps.capacity.delete(token),300000).unref();
          return;
        }
      }
      try {
        await authorizeExecution();
        if (session) {
          await this.deps.preparePrompt(ctx, session, preparations);
          if (hasTask) await this.submitSessionPrompt(ctx, session, content, {key:skillKey,names:pendingSkills,topicSkill});
        } else await this.deps.newSession(ctx, hasTask ? content : undefined, undefined, undefined, hasTask && !worktree ? () => this.consumePendingSkills(skillKey,pendingSkills) : undefined, worktree, ctx, preparations, reservation, cwd);
      } finally { reservation?.release(); }
      return;
    }
    if (preparations.length) throw new Error('Prompt preparations require a group administrator.');
    if (!this.deps.usersCanProposePrompts(ctx.chat!.id)) return;
    const now = Date.now();
    for (const [token, proposal] of this.promptProposals) if (proposal.expires <= now) this.promptProposals.delete(token);
    const token = randomBytes(16).toString('base64url');
    await this.deps.authorize(ctx.chat!.id,ctx.from!.id);
    const message = await replyTo(ctx, contextDestination(ctx), 'Approve this prompt?', {
      reply_parameters:{message_id:ctx.message!.message_id,allow_sending_without_reply:true},
      reply_markup:{inline_keyboard:[[{text:'Approve prompt',callback_data:`prompt:approve:${token}`}]]},
    });
    this.promptProposals.set(token, {
      source:ctx,content:structuredClone(content),instanceId,worktree,
      ...(session ? {sessionId:session.id,generation:this.deps.options.store.getSessionGeneration(session.id)} : {folderFingerprint}),
      skills:{key:skillKey,names:[...new Set([...pendingSkills,...extensions.flatMap(extension => extension.kind === 'skill' ? [extension.name] : [])])],topicSkill},
      allMessagesArePrompts:this.deps.allMessagesArePrompts(ctx.chat!.id),messageId:message.message_id,expires:now+600000,
    });
  }
  async approvePrompt(ctx: Context, token: string): Promise<void> {
    const proposal = this.promptProposals.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!proposal || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== proposal.source.chat!.id || message.message_id !== proposal.messageId ||
        !sameTopicDestination(contextDestination(ctx), contextDestination(proposal.source)) ||
        !('from' in message) || message.from?.id !== this.deps.id() || 'forward_origin' in message || 'forward_date' in message) return;
    if (!(await this.deps.currentAdmin(ctx))) {
      await ctx.answerCallbackQuery('Only an admin authorized for the target session or new-topic creation can approve this prompt.');
      return;
    }
    await this.deps.authorize(ctx.chat.id, ctx.from!.id);
    const session = proposal.sessionId ? this.deps.options.store.getSession(proposal.sessionId) : undefined;
    if (proposal.expires <= Date.now() || !this.deps.usersCanProposePrompts(ctx.chat.id) ||
        this.deps.allMessagesArePrompts(ctx.chat.id) !== proposal.allMessagesArePrompts ||
        findInstance(this.deps.options.config,this.deps.id(),ctx.chat.id)?.instance.id !== proposal.instanceId ||
        (!proposal.sessionId && proposal.folderFingerprint !== JSON.stringify(this.deps.folderSettings(ctx.chat.id))) ||
        (proposal.sessionId && (!session || !this.deps.sessionAssigned(session) || session.status !== 'open' ||
          this.deps.options.store.getSessionGeneration(proposal.sessionId) !== proposal.generation))) {
      this.promptProposals.delete(token);
      await ctx.editMessageText('This prompt proposal is no longer active.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    await this.deps.authorize(ctx.chat.id, proposal.source.from!.id);
    if (this.promptProposals.get(token) !== proposal) return;
    this.promptProposals.delete(token);
    await ctx.editMessageReplyMarkup({reply_markup:{inline_keyboard:[]}});
    if (!(await this.deps.currentAdmin(ctx))) throw new Error('Administrator access changed before prompt approval.');
    if (this.deps.assignedId(ctx.chat.id) !== proposal.instanceId ||
        (!proposal.sessionId && proposal.folderFingerprint !== JSON.stringify(this.deps.folderSettings(ctx.chat.id))))
      throw new Error('The prompt proposal assignment or folder settings changed before execution.');
    if (session) {
      if (!(await this.submitSessionPrompt(proposal.source,session,proposal.content,proposal.skills,ctx))) {
        await ctx.editMessageText('Prompt not submitted: the initial task is still being admitted. Propose it again after startup.');
        return;
      }
    } else await this.deps.newSession(proposal.source,proposal.content,undefined,undefined,proposal.skills ? () => this.consumePendingSkills(proposal.skills!.key,proposal.skills!.names) : undefined,proposal.worktree,ctx,[],undefined,undefined,proposal.skills);
    await ctx.editMessageText('Prompt approved.',{reply_markup:{inline_keyboard:[]}});
  }
  consumePendingSkills(key: PendingSkillKey, names: readonly string[]): void {
    const remaining = this.deps.options.store.getPendingSkills(key).filter(name => !names.includes(name));
    this.deps.options.store.clearPendingSkills(key);
    for (const name of remaining) this.deps.options.store.addPendingSkill(key,name);
  }
  async submitSessionPrompt(ctx: Context, session: TopicSession, content: PendingPromptContent, selected?: {key:PendingSkillKey;names:string[];topicSkill?:string}, authority = ctx): Promise<boolean> {
    await this.deps.authorize(ctx.chat!.id,ctx.from!.id);
    this.deps.requireSessionAssignment(session);
    await this.deps.listen(session);
    await this.deps.authorize(ctx.chat!.id,ctx.from!.id);
    if (!(await this.deps.currentAdmin(authority))) throw new Error('Administrator access changed before prompt submission.');
    if (this.deps.listener(session.id)?.initial) {
      await replyTo(ctx, contextDestination(ctx), 'The initial task is still being admitted. Wait for the host to start before sending another instruction.');
      return false;
    }
    const prompt = await this.deps.uploadDocuments(ctx, session, content, authority);
    const messageId = ctx.message!.message_id;
    const restore = selected && (selected.names.length || selected.topicSkill) ? () => {
      if (selected.names.length) {
        const current = this.deps.options.store.getPendingSkills(selected.key);
        this.deps.options.store.clearPendingSkills(selected.key);
        for (const name of [...selected.names, ...current]) this.deps.options.store.addPendingSkill(selected.key, name);
      }
      if (selected.topicSkill) this.deps.options.store.setNewTopicSkill(session.id,selected.topicSkill);
    } : undefined;
    if (selected) {
      this.consumePendingSkills(selected.key,selected.names);
      if (selected.topicSkill) this.deps.options.store.clearNewTopicSkill(session.id);
    }
    for (const original of this.deps.albumContexts(ctx))
      if (original.message && original.message.message_id !== messageId)
        this.deps.options.store.recordPromptMessageAlias(session.id, messageId, original.message.message_id);
    try {
      this.deps.sendPrompt(this.deps.listener(session.id)!,prompt,messageId,restore);
    } catch (error) {
      restore?.();
      throw error;
    }
    return true;
  }
}
