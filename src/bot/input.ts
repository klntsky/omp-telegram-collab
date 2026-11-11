import { HttpError, type Bot, type Context } from 'grammy';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import type { Store } from '../store.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { SessionCapacityError } from '../runtime/types.js';
import { findInstance } from '../config.js';
import { contextDestination, replyTo } from '../telegram-destination.js';
import { classifyMessage, normalizeMessage, type InputIntent } from '../telegram-input.js';
import type { SkillCatalogEntry } from '../skill-picker.js';
import type { BotQuestions } from './questions.js';
import type { SessionObservation, SettingsPanel } from './types.js';

interface InputDependencies {
 bot: Bot<Context>; config: AppConfig; store: Store; delivery: TelegramDelivery; questions: BotQuestions;
 skillAliases: Map<number, Map<string, SkillCatalogEntry>>;
 botId(): number; stopped(): boolean; sessionAssigned(session: TopicSession): boolean;
 sessionObservation(id: string): SessionObservation; settingsReplyPanel(ctx: Context): SettingsPanel | undefined;
 allMessagesArePrompts(chatId: number): boolean; usersCanProposePrompts(chatId: number): boolean;
 currentAdmin(ctx: Context): Promise<boolean>; handle(ctx: Context, intent: InputIntent): Promise<void>;
}

export class BotInput {
 private readonly inputIntents = new WeakMap<Context, InputIntent>();
 private readonly albums = new Map<string, {contexts:Context[];ready:Promise<void>;resolve:()=>void;timer?:NodeJS.Timeout}>();
 private readonly albumPrompts = new WeakMap<Context, {contexts:Context[]}>();
 private updateTail: Promise<void> = Promise.resolve();
 private queuedUpdates = 0;
 constructor(private readonly deps: InputDependencies) {}
 albumContexts(ctx: Context): Context[] { return this.albumPrompts.get(ctx)?.contexts ?? [ctx]; }
 completion(): Promise<void> { return this.updateTail; }
 closeAlbums(): void {
   for (const album of this.albums.values()) { clearTimeout(album.timer); album.resolve(); }
   this.albums.clear();
 }

install(): void {
    this.deps.bot.use(async (ctx) => {
      let callbackAnswered = false;
      const answerCallbackQuery = ctx.answerCallbackQuery.bind(ctx);
      ctx.answerCallbackQuery = async (...args) => {
        const result = await answerCallbackQuery(...args);
        callbackAnswered = true;
        return result;
      };
      if (this.collectAlbum(ctx)) return;
      const intent = this.classifyInput(ctx);
      const urgent = intent.kind === 'command' && intent.action === 'terminate';
      if (++this.queuedUpdates > 256 && !urgent) {
        this.queuedUpdates--;
        return;
      }
      const received = this.receiveMessage(ctx, intent);
      const process = async () => {
        await received;
        await this.deps.handle(ctx, intent);
      };
      const task = urgent ? process() : this.updateTail.then(process);
      if (!urgent) this.updateTail = task.catch(() => undefined);
      try {
        await task;
      } catch (error) {
        await this.reportError(ctx, error);
      } finally {
        this.queuedUpdates--;
        if (ctx.callbackQuery && !callbackAnswered)
          await ctx.answerCallbackQuery().catch(error => console.warn('Could not acknowledge Telegram callback.', error));
      }
    });
}

  private async reportError(ctx: Context, error: unknown): Promise<void> {
    console.error('Telegram operation failed.', error);
    const intent = this.inputIntents.get(ctx);
    if (ctx.chat && ctx.message && !(intent?.kind === 'command' && intent.action === 'status')) {
      const session = this.deps.store.getTopic({botId:this.deps.botId(),destination:contextDestination(ctx)});
      if (session && this.deps.sessionAssigned(session)) this.deps.sessionObservation(session.id).failure = {operation:'Telegram operation',at:Date.now(),error};
    }
    if (!ctx.chat || error instanceof SessionCapacityError) return;
    const diagnostic = error instanceof HttpError && error.error instanceof Error ? error.error : error;
    const diagnostics = diagnostic instanceof Error
      ? ['code','signal','killed'].flatMap(key => {
          const value = Reflect.get(diagnostic,key);
          return value === undefined || value === null ? [] : [`${key}: ${String(value)}`];
        })
      : [];
    const prefix = `The operation could not be completed. Check the local service and try again.\n\n${diagnostics.length ? diagnostics.join('\n') + '\n\n' : ''}`;
    const details = error instanceof Error ? error.message : String(error);
    await replyTo(ctx, contextDestination(ctx), prefix + details, {
      entities: [{type:'pre',offset:prefix.length,length:details.length}],
    }).catch(deliveryError => console.error('Could not deliver Telegram operation error notice.', deliveryError));
  }

  private collectAlbum(ctx: Context): boolean {
    const message = ctx.message;
    if (!message || !('media_group_id' in message) || !message.media_group_id ||
        !ctx.chat || ctx.chat.type !== 'supergroup' || !ctx.from || ctx.from.is_bot ||
        'forward_origin' in message || 'forward_date' in message ||
        !(message.photo || message.document?.mime_type?.startsWith('image/'))) return false;
    const key = `${JSON.stringify(contextDestination(ctx))}:${ctx.from.id}:${message.media_group_id}`;
    let album = this.albums.get(key);
    if (!album) {
      this.queuedUpdates++;
      const ready = Promise.withResolvers<void>();
      album = {contexts:[],ready:ready.promise,resolve:ready.resolve};
      this.albums.set(key,album);
      const pending = album;
      const task = this.updateTail.then(async () => {
        await pending.ready;
        this.albums.delete(key);
        const source = pending.contexts.find(part => part.message && 'caption' in part.message && part.message.caption) ?? pending.contexts[0]!;
        this.albumPrompts.set(source,{contexts:pending.contexts});
        const intent = this.classifyInput(source);
        await this.receiveMessage(source,intent);
        await this.deps.handle(source,intent);
      });
      this.updateTail = task.catch(error => this.reportError(ctx,error)).finally(() => { this.queuedUpdates--; });
    }
    album.contexts.push(ctx);
    clearTimeout(album.timer);
    album.timer = setTimeout(album.resolve,250);
    return true;
  }

  private classifyInput(ctx: Context): InputIntent {
    const message = ctx.message;
    if (!message || !ctx.chat) return {kind:'event'};
    if (this.deps.settingsReplyPanel(ctx)) return {kind:'event'};
    const reply = message.reply_to_message;
    const question = reply?.from?.id === this.deps.botId() ? this.deps.questions.findReplyToken(ctx.chat.id, message.message_thread_id, reply.message_id) : undefined;
    const replyKey = reply?.from?.id === this.deps.botId() ? `${ctx.chat.id}:${reply.message_id}` : undefined;
    const discussion = replyKey === undefined ? undefined : this.deps.questions.endedReply(replyKey);
    const discussionSession = discussion && this.deps.store.getSession(discussion.sessionId);
    const canDiscuss = discussionSession?.chatId === ctx.chat.id && discussionSession.threadId === message.message_thread_id &&
      this.deps.store.getSessionGeneration(discussionSession.id) === discussion?.generation;
    const messages = (this.albumPrompts.get(ctx)?.contexts ?? [ctx]).flatMap(part => part.message ? [part.message] : []);
    const intent = classifyMessage(message,normalizeMessage(messages),{
      botId:this.deps.botId(),username:this.deps.bot.botInfo!.username,
      allMessagesArePrompts:this.deps.allMessagesArePrompts(ctx.chat.id),
      skillAliases:this.deps.skillAliases.get(ctx.chat.id) ?? new Map(),
      question,
      endedQuestion:replyKey !== undefined && this.deps.questions.hasEndedReply(replyKey) && !canDiscuss,
    });
    this.inputIntents.set(ctx,intent);
    return intent;
  }

  private async receiveMessage(ctx: Context, intent: InputIntent): Promise<void> {
    if (intent.kind !== 'new-task' && intent.kind !== 'session-prompt' && intent.kind !== 'question-answer' &&
        !(intent.kind === 'command' && ['stop','kill','worktree','modelpreset'].includes(intent.action))) return;
    const message = ctx.message;
    if (this.deps.config.terminated || this.deps.stopped() || !message || !ctx.chat || ctx.chat.type !== 'supergroup') return;
    const assigned = findInstance(this.deps.config,this.deps.botId(),ctx.chat.id);
    if (!assigned || !this.deps.store.isEnrolled(this.deps.botId(),ctx.chat.id)) return;
    const destination = contextDestination(ctx);
    const detached = destination.kind === 'topic' && this.deps.store.getTopicKind({botId:this.deps.botId(),chatId:destination.chatId,threadId:destination.threadId}) === 'detached';
    if (detached) return;
    const topic = this.deps.store.getTopic({botId:this.deps.botId(),destination});
    if (topic && topic.status !== 'open') return;
    if ((intent.kind === 'new-task' || intent.kind === 'session-prompt') &&
        !this.deps.usersCanProposePrompts(ctx.chat.id) && !(await this.deps.currentAdmin(ctx))) return;
    await this.deps.delivery.run(ctx.chat.id,
      () => this.deps.bot.api.setMessageReaction(ctx.chat!.id,message.message_id,[{type:'emoji',emoji:'👀'}]),
      () => !this.deps.stopped() && findInstance(this.deps.config,this.deps.botId(),ctx.chat!.id)?.instance.id === assigned.instance.id)
      .catch(error => console.warn('Could not show message receipt reaction.', error));
  }
}
