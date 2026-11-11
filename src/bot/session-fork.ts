import { logEvent } from '../logging.js';
import type { Context, Bot } from 'grammy';
import type { TopicSession, PromptContent, HostBinding } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import { contextDestination, replyTo, sendTo, forwardTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { refreshTermination } from '../config.js';
export interface SessionForkDependencies {
  options: BotOptions;
  bot: Bot<Context>;
  id: number;
  readonly admissionEpoch: number;
  readonly stopped: boolean;
  authorize(chatId: number, userId: number): Promise<unknown>;
  currentAdmin(ctx: Context): Promise<boolean>;
  requireSessionAssignment(session: TopicSession): void;
  defaultNewTopicSkill(chatId: number): string | undefined;
  createsTopicWorktrees(chatId: number): boolean;
  createTopicWorktree(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<void>;
  announce(session: TopicSession): Promise<void>;
  listen(session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>): Promise<unknown>;
  dropListener(sessionId: string): void;
}

export class SessionFork {
  constructor(private readonly dependencies: SessionForkDependencies) {}
  async forkSession(ctx: Context, source: TopicSession): Promise<void> {
    const generation = this.dependencies.options.store.getSessionGeneration(source.id);
    const epoch = this.dependencies.admissionEpoch;
    const check = async () => {
      await this.dependencies.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.dependencies.currentAdmin(ctx))) throw new Error('Forking requires a group administrator.');
      if (this.dependencies.stopped || refreshTermination(this.dependencies.options.config) || epoch !== this.dependencies.admissionEpoch)
        throw new Error('The service changed before the fork completed');
      this.dependencies.requireSessionAssignment(source);
      if (source.runtime.kind !== 'managed' || this.dependencies.options.store.getSession(source.id)?.status !== 'open' ||
          this.dependencies.options.store.getSessionGeneration(source.id) !== generation)
        throw new Error('The source session changed before the fork completed');
    };
    await check();
    let target: {ompSessionId:string;entryId:string;parentEntryId:string|null;kind:'assistant'|'collab-prompt'} | undefined;
    const replied = ctx.message?.reply_to_message;
    const reply = replied && !replied.forum_topic_created && replied.message_id !== source.threadId
      ? replied : undefined;
    if (reply) {
      const binding = await this.dependencies.options.runtime.existingBinding(source);
      target = binding && this.dependencies.options.store.getMessageAnchor(source.id, binding.sessionId, source.chatId, reply.message_id);
      if (!target || reply.message_thread_id !== source.threadId)
        throw new Error('Reply to a persisted message in the current session to select a fork point.');
    }
    const releaseSource = this.dependencies.options.runtime.retain(source.id);
    let reservation: {bind(id:string):void;release():void} | undefined;
    let topic: {message_thread_id:number} | undefined;
    let destination: TopicSession | undefined;
    let prepared = false;
    try {
      reservation = await this.dependencies.options.runtime.reserveSession(undefined, check);
      await check();
      topic = await this.dependencies.bot.api.createForumTopic(source.chatId, source.name.slice(0, 128) || 'OMP session');
      await check();
      destination = this.dependencies.options.store.createSession(
        {botId:this.dependencies.id,chatId:source.chatId,threadId:topic.message_thread_id,instanceId:source.instanceId,cwd:source.cwd},
        source.name, {kind:'managed'}, undefined, ctx.from!.id, ctx.from!.id, 'fork',
      );
      reservation.bind(destination.id);
      const destinationGeneration = this.dependencies.options.store.getSessionGeneration(destination.id);
      const beforeMutation = async () => {
        await check();
        this.dependencies.requireSessionAssignment(destination!);
        if (this.dependencies.options.store.getSession(destination!.id)?.status !== 'open' ||
            this.dependencies.options.store.getSessionGeneration(destination!.id) !== destinationGeneration)
          throw new Error('The destination session changed before the fork completed');
      };
      releaseSource();
      await this.dependencies.options.runtime.fork(source, destination, target, beforeMutation);
      await beforeMutation();
      this.dependencies.options.store.setSessionCwd(destination.id, destination.cwd);
      const defaultSkill = this.dependencies.defaultNewTopicSkill(source.chatId);
      if (defaultSkill) this.dependencies.options.store.setNewTopicSkill(destination.id, defaultSkill);
      if (this.dependencies.createsTopicWorktrees(source.chatId)) {
        await this.dependencies.createTopicWorktree(destination, beforeMutation);
      }
      await beforeMutation();
      this.dependencies.options.store.finishInitialTaskPreparation(destination.id);
      prepared = true;
      await sendTo(this.dependencies.bot.api, topicDestination(destination.chatId, destination.threadId),
        `Forked from: https://t.me/c/${String(source.chatId).replace(/^-100/, '')}/${reply?.message_id ?? ctx.message!.message_id}?thread=${source.threadId}`,
        {link_preview_options:{is_disabled:true}});
      await this.dependencies.announce(destination);
      await beforeMutation();
      await this.dependencies.listen(destination, undefined, beforeMutation);
      await replyTo(ctx, contextDestination(ctx), `Topic created: https://t.me/c/${String(source.chatId).replace(/^-100/, '')}/${topic.message_thread_id}`);
    } catch (error) {
      if (topic && !prepared) {
        this.dependencies.options.store.detachTopic({botId:this.dependencies.id,chatId:source.chatId,threadId:topic.message_thread_id});
        if (destination) this.dependencies.dropListener(destination.id);
        await replyTo(ctx, contextDestination(ctx), `Topic created: https://t.me/c/${String(source.chatId).replace(/^-100/, '')}/${topic.message_thread_id}`).catch(deliveryError => {
          logEvent('error', 'could-not-deliver-the-created-topic-link-after-fork-preparation-failed', {botId: source.botId, sessionId: source.id, chatId: source.chatId, threadId: topic?.message_thread_id, message: 'Could not deliver the created topic link after fork preparation failed.', error: deliveryError});
        });
      }
      throw error;
    } finally {
      if (destination) this.dependencies.options.store.finishInitialTaskPreparation(destination.id);
      releaseSource();
      reservation?.release();
    }
  }
}
