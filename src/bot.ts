import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { Telegraf, TelegramError, type Context } from 'telegraf';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabUiRequest, type HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, BotConfig, TopicSession, HostBinding, CollabConnection } from '../shared/contracts.js';
import { Store } from './store.js';
import { isActiveMember, isAdministrator } from './auth.js';
import { connectCollab, isStartupRejection } from './collab.js';
import { renderTelegramMarkdown } from './telegram-markdown.js';
import { SessionCapacityError } from './runtime.js';
import { configWritable, findInstance, readConfig, writeConfig } from './config.js';
import { miniAppInterruptionAuthor } from '../shared/interruption.js';
import { TelegramDelivery } from './telegram-delivery.js';

export interface RuntimeLike {
  ensure(session: TopicSession): Promise<HostBinding>;
  isRunning(session: TopicSession): Promise<boolean>;
  attach(instanceId: string, instancePath: string): Promise<HostBinding>;
  stop(id: string): Promise<void>;
  kill(session: TopicSession): Promise<void>;
  modelPresets(session: TopicSession, name?: string): Promise<string>;
  availableModelPresets(instancePath: string): Promise<string[]>;
  getSessionLimit(): number;
  increaseSessionLimit(expectedLimit: number): boolean;
  observeFrame(sessionId: string, frame: HostFrame): void;
  markPrompt(sessionId: string): void;
  retain(sessionId: string): () => void;
  close(): Promise<void>;
}
export interface BotOptions { config: AppConfig; botConfig: BotConfig; token: string; store: Store; runtime: RuntimeLike; connect?: typeof connectCollab; bot?: Telegraf<Context>; configWritable?: () => boolean; telegramIntervalMs?: number }
type TopicActivity = 'running' | 'completed' | 'stopped';
interface Listener {
  sessionId: string;
  connection?: CollabConnection;
  promise?: Promise<CollabConnection>;
  tail: Promise<void>;
  queued: number;
  recovering: boolean;
  pendingPrompts: { text: string; messageId?: number }[];
  pendingAnswers: Map<number, number>;
  pendingStops: number[];
  queuedMessages: number;
  activity: 'running' | 'completed';
  initial?: {
    text: string;
    userId: number;
    messageId?: number;
    deadline: number;
    retries: number;
    phase: 'sent' | 'retrying';
    timer?: NodeJS.Timeout;
  };
}
interface PendingQuestion {
  session: TopicSession;
  listener: Listener;
  request: CollabUiRequest;
  messageIds: number[];
  buttonIds: number[];
  answer?: string;
}
interface CapacityRequest {
  sessionId: string;
  chatId: number;
  threadId: number;
  messageId: number;
  limit: number;
  expires: number;
}
interface PromptProposal {
  source: Context;
  text: string;
  instancePath: string;
  sessionId?: string;
  generation?: number;
  allMessagesArePrompts: boolean;
  messageId: number;
  expires: number;
}
const help = '/setup — request or enroll this forum (instance admin; group admin for unassigned forums)\n/new task — new topic and session\n/attach instanceId [name] — attach local host (instance admin)\n/detach — make this topic conversation-only (instance admin)\n/model_preset <name> — set the forum default in General, or switch this session (instance admin)\n/list_model_presets — list presets and the forum default (instance admin)\n/session — open this session\n/status — readiness\n/stop — interrupt the current turn (session topic only)\n/kill — force-kill the host process (session topic only)';
const groupCommands = [
  { command: 'new', description: 'Start a new session' },
  { command: 'p', description: 'New session in General; prompt in explicit-command topics' },
  { command: 'setup', description: 'Enroll this forum or change prompt settings' },
  { command: 'attach', description: 'Attach a local OMP host (instance admin)' },
  { command: 'detach', description: 'Make this topic conversation-only (instance admin)' },
  { command: 'session', description: 'Open this topic’s session' },
  { command: 'status', description: 'Check forum and session readiness' },
  { command: 'stop', description: 'Interrupt the current turn in this session topic' },
  { command: 'kill', description: 'Force-kill this session’s host; preserve history' },
  { command: 'model_preset', description: 'Set default in General or switch session (admin)' },
  { command: 'list_model_presets', description: 'List presets and forum default (instance admin)' },
  { command: 'help', description: 'Show commands and prompt settings' },
  { command: 'start', description: 'Show bot setup and command guidance' },
];
function optionMarker(index: number): string {
  const number = index+1;
  return number === 10 ? '🔟' : String(number).replace(/\d/g, digit => `${digit}\uFE0F\u20E3`);
}
function assistantText(message: unknown): { text: string; fingerprint: string } | undefined {
  if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'assistant' || !('content' in message) || !Array.isArray(message.content)) return undefined;
  const text = message.content.filter((part): part is {type:'text';text:string} => Boolean(part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')).map(part => part.text).join('\n');
  if (!text.trim()) return undefined;
  const timestamp = 'timestamp' in message ? message.timestamp : null;
  return { text, fingerprint: createHash('sha256').update(JSON.stringify([timestamp, text])).digest('hex') };
}

function retryDelay(ms: number, signal: TelegramAbortController['signal']): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
  return promise;
}
export class BotService {
  readonly bot: Telegraf<Context>;
  readonly config: BotConfig;
  readonly token: string;
  private readonly listeners = new Map<string, Listener>();
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  private readonly capacityRequests = new Map<string, CapacityRequest>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly endedQuestionReplies = new Set<string>();
  private readonly delivery: TelegramDelivery;
  private readonly topicIcons = new Map<string, { status?: TopicActivity; tail: Promise<void> }>();
  private readonly sessionKillHandlers = new Set<(sessionId: string) => void>();
  private readonly commandModes = new Map<number, boolean>();
  private readonly promptProposals = new Map<string, PromptProposal>();
  private readonly receivedMessages = new WeakSet<Context>();
  private iconIds?: Promise<Record<TopicActivity, string>>;
  private statusTimer?: NodeJS.Timeout;
  private checkingStatuses = false;
  private updateTail: Promise<void> = Promise.resolve();
  private queuedUpdates = 0;
  private stopped = false;
  private polling?: { controller: TelegramAbortController; done: Promise<void> };
  constructor(private readonly options: BotOptions) {
    this.bot = options.bot ?? new Telegraf(options.token);
    this.delivery = new TelegramDelivery(options.telegramIntervalMs);
    this.config = options.botConfig;
    this.token = options.token;
    this.bot.use(async ctx => {
      if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => undefined);
      if (++this.queuedUpdates > 256) { this.queuedUpdates--; return; }
      const received = this.receiveMessage(ctx);
      const task = this.updateTail.then(async () => { await received; await this.handle(ctx); });
      this.updateTail = task.catch(() => undefined);
      try { await task; } catch (error) {
        if (ctx.chat && !(error instanceof SessionCapacityError)) {
          const prefix = 'The operation could not be completed. Check the local service and try again.\n\n';
          const details = error instanceof Error ? error.message : String(error);
          await ctx.reply(prefix + details, {
            entities: [{ type: 'pre', offset: prefix.length, length: details.length }],
          }).catch(() => undefined);
        }
      }
      finally { this.queuedUpdates--; }
    });
    this.bot.catch(() => undefined);
  }
  private async receiveMessage(ctx: Context, interaction = false): Promise<void> {
    const message = ctx.message;
    if (this.stopped || !message || !ctx.chat || ctx.chat.type !== 'supergroup' || !ctx.from || ctx.from.is_bot ||
        !('text' in message) || 'forward_origin' in message || 'forward_date' in message) return;
    if (this.receivedMessages.has(ctx)) return;
    const assigned = findInstance(this.options.config,this.id,ctx.chat.id);
    if (!assigned || !this.options.store.isEnrolled(this.id,ctx.chat.id)) return;
    if (this.options.store.getTopic({botId:this.id,chatId:ctx.chat.id,threadId:message.message_thread_id ?? 1})?.status === 'detached') return;
    if (!interaction && !this.allMessagesArePrompts(ctx.chat.id) && !message.text.startsWith('/')) return;
    const promptInput = !message.text.startsWith('/') || /^\/(?:new|p)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(message.text);
    if (!interaction && promptInput && !this.usersCanProposePrompts(ctx.chat.id) && !(await this.instanceAdmin(ctx))) return;
    await this.delivery.run(ctx.chat.id,
      () => this.bot.telegram.setMessageReaction(ctx.chat!.id,message.message_id,[{type:'emoji',emoji:'👀'}]),
      () => !this.stopped && findInstance(this.options.config,this.id,ctx.chat!.id)?.path === assigned.path).catch(() => undefined);
    this.receivedMessages.add(ctx);
  }
  get id(): number { return this.bot.botInfo?.id ?? 0; }
  async initialize(): Promise<void> {
    this.bot.botInfo ??= await this.bot.telegram.getMe();
    await this.bot.telegram.setMyCommands(
      groupCommands,
      { scope: { type: 'all_group_chats' } },
    );
    await this.syncCommandMenus();
    for (const existing of this.options.store.listSessions(this.id)) {
      if (!this.sessionAssigned(existing)) continue;
      const generation = this.options.store.getSessionGeneration(existing.id);
      void (async () => {
        const shouldListen = existing.status === 'open' && (this.options.store.hasPendingInitialTask(existing.id) || await this.options.runtime.isRunning(existing));
        if (this.stopped || !this.sessionAssigned(existing) || this.options.store.getSessionGeneration(existing.id) !== generation) return;
        if (shouldListen) await this.sendInitial(existing);
        else await this.refreshTopicStatus(existing);
      })().catch(error => {
        if (!this.stopped && !(error instanceof SessionCapacityError) && this.options.store.getSessionGeneration(existing.id) === generation) this.scheduleReconnect(existing);
      });
    }
    this.statusTimer ??= setInterval(() => {
      if (this.stopped || this.checkingStatuses) return;
      this.checkingStatuses = true;
      void (async () => {
        for (const session of this.options.store.listSessions(this.id)) {
          if (this.stopped) break;
          if (this.sessionAssigned(session)) await this.refreshTopicStatus(session).catch(() => undefined);
        }
      })().finally(() => { this.checkingStatuses = false; });
    }, 30000);
    this.statusTimer.unref();
  }
  onSessionKill(handler: (sessionId: string) => void): () => void {
    this.sessionKillHandlers.add(handler);
    return () => { this.sessionKillHandlers.delete(handler); };
  }
  async ensureMirroring(session: TopicSession, binding: HostBinding): Promise<void> {
    this.requireSessionAssignment(session);
    await this.listen(session,binding);
  }
  async relayPrompt(session: TopicSession, user: {userId:number;username?:string;displayName:string}, text: string): Promise<void> {
    this.requireSessionAssignment(session);
    const author = user.username ? `@${user.username}` : `${user.displayName} (user ID ${user.userId})`;
    const message = `${author} posted a prompt: ${text}`;
    for (let offset = 0; offset < message.length;) {
      let end = Math.min(offset+4000,message.length);
      if (end < message.length && message.charCodeAt(end-1) >= 0xD800 && message.charCodeAt(end-1) <= 0xDBFF) end--;
      this.requireSessionAssignment(session);
      await this.bot.telegram.sendMessage(session.chatId,message.slice(offset,end),{message_thread_id:session.threadId});
      offset = end;
    }
  }
  async start(onReady?: () => void): Promise<void> {
    await this.initialize();
    if (this.stopped) return;
    if (!this.polling) {
      const controller = new TelegramAbortController();
      this.polling = { controller, done: this.poll(controller, onReady) };
    }
    await this.polling.done;
  }
  private async poll(controller: TelegramAbortController, onReady?: () => void): Promise<void> {
    let offset = 0;
    try {
      let webhookRemoved = false;
      while (!controller.signal.aborted) {
        try {
          if (!webhookRemoved) {
            await this.bot.telegram.callApi('deleteWebhook', { drop_pending_updates: false }, { signal: controller.signal });
            webhookRemoved = true;
          }
          const updates = await this.bot.telegram.callApi('getUpdates', {
            offset, timeout: onReady ? 0 : 30, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
          }, { signal: controller.signal });
          if (controller.signal.aborted) break;
          onReady?.();
          onReady = undefined;
          for (const update of updates) {
            if (controller.signal.aborted) break;
            await this.bot.handleUpdate(update);
            offset = update.update_id + 1;
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          const temporary = error instanceof TelegramError && (error.code === 429 || error.code >= 500);
          if (!temporary && !(error instanceof Error && error.name === 'FetchError')) throw error;
          const seconds = error instanceof TelegramError ? error.parameters?.retry_after ?? 5 : 5;
          await retryDelay(Math.max(0, seconds) * 1000, controller.signal);
        }
      }
    } finally {
      if (controller.signal.aborted && offset > 0) {
        const acknowledgement = new TelegramAbortController();
        const timeout = setTimeout(() => acknowledgement.abort(), 5000);
        try {
          await this.bot.telegram.callApi('getUpdates', { offset, limit: 1, timeout: 0 }, {
            signal: acknowledgement.signal,
          }).catch(() => undefined);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.delivery.close();
    clearInterval(this.statusTimer);
    this.polling?.controller.abort();
    await this.polling?.done.catch(() => undefined);
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    this.reconnects.clear();
    this.capacityRequests.clear();
    this.promptProposals.clear();
    for (const token of this.questions.keys()) this.endQuestion(token);
    const listeners = [...this.listeners.values()];
    for (const item of listeners) {
      clearTimeout(item.initial?.timer);
      item.connection?.close();
    }
    this.listeners.clear();
    await this.updateTail;
    await Promise.all(listeners.map(listener => listener.tail));
    await Promise.all([...this.topicIcons.values()].map(icon => icon.tail));
  }
  async authorize(chatId: number, userId: number): Promise<void> {
    const instancePath = this.assignedPath(chatId);
    if (!this.options.store.isEnrolled(this.id, chatId)) throw new Error('Group not enrolled');
    const [chat, user, bot] = await Promise.all([this.bot.telegram.getChat(chatId), this.bot.telegram.getChatMember(chatId, userId), this.bot.telegram.getChatMember(chatId, this.id)]);
    if (this.assignedPath(chatId) !== instancePath) throw new Error('The group instance assignment changed');
    if (chat.type !== 'supergroup' || !chat.is_forum || !isActiveMember(user) || bot.status !== 'administrator' || !bot.can_manage_topics) throw new Error('Group access denied');
  }
  private async ready(chatId: number): Promise<boolean> {
    const [chat, member] = await Promise.all([this.bot.telegram.getChat(chatId), this.bot.telegram.getChatMember(chatId, this.id)]);
    return chat.type === 'supergroup' && chat.is_forum === true && member.status === 'administrator' && member.can_manage_topics === true && member.can_pin_messages === true;
  }
  private assignedPath(chatId: number): string {
    const assigned = findInstance(this.options.config, this.id, chatId);
    if (!assigned) throw new Error('This group has no configured instance assignment');
    try {
      if (realpathSync(assigned.path) !== assigned.path || !statSync(assigned.path).isDirectory()) throw new Error();
    } catch {
      throw new Error('The configured instance directory is unavailable');
    }
    return assigned.path;
  }
  private sessionAssigned(session: TopicSession): boolean {
    if (session.botId !== this.id || !this.options.store.isEnrolled(this.id, session.chatId)) return false;
    const stored = this.options.store.getSession(session.id);
    if (!stored || stored.status === 'detached' || stored.botId !== session.botId || stored.chatId !== session.chatId || stored.threadId !== session.threadId || stored.instancePath !== session.instancePath || !session.instancePath) return false;
    try { return this.assignedPath(session.chatId) === session.instancePath; } catch { return false; }
  }
  private requireSessionAssignment(session: TopicSession): void {
    if (!this.sessionAssigned(session)) throw new Error('This session is not assigned to its configured instance path');
  }
  private allMessagesArePrompts(chatId: number): boolean {
    return findInstance(this.options.config, this.id, chatId)?.instance.chats
      .find(chat => chat.botId === this.id && chat.chatId === chatId)?.all_messages_are_prompts !== false;
  }
  private usersCanProposePrompts(chatId: number): boolean {
    return findInstance(this.options.config, this.id, chatId)?.instance.chats
      .find(chat => chat.botId === this.id && chat.chatId === chatId)?.users_can_propose_prompts === true;
  }
  private promptHelp(chatId: number): string {
    const input = this.allMessagesArePrompts(chatId)
      ? 'Text messages in a session topic are treated as prompts.'
      : 'Use /p <prompt> in a session topic. Ordinary messages, mentions, and replies are ignored.';
    return `${input}\nIn General, /p works like /new (with a task or an interactive reply).\n${this.usersCanProposePrompts(chatId)
      ? 'Non-admin prompts require approval by an instance admin.'
      : 'Only instance admins can send prompts. Other members’ messages are ignored.'}`;
  }
  private async syncCommandMenus(): Promise<void> {
    const current = new Set<number>();
    for (const instance of Object.values(this.options.config.instances)) {
      for (const chat of instance.chats) {
        if (chat.botId !== this.id) continue;
        current.add(chat.chatId);
        const all = chat.all_messages_are_prompts !== false;
        if (this.commandModes.get(chat.chatId) === all) continue;
        await this.bot.telegram.setMyCommands(groupCommands, { scope: { type: 'chat', chat_id: chat.chatId } });
        this.commandModes.set(chat.chatId, all);
      }
    }
    for (const chatId of this.commandModes.keys()) {
      if (current.has(chatId)) continue;
      await this.bot.telegram.deleteMyCommands({ scope: { type: 'chat', chat_id: chatId } });
      this.commandModes.delete(chatId);
    }
  }
  private isInstanceAdmin(chatId: number, user: Context['from']): boolean {
    const assigned = findInstance(this.options.config, this.id, chatId);
    return Boolean(assigned && user && !user.is_bot && user.username && assigned.instance.admins.includes(user.username.toLowerCase()));
  }
  private async instanceAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.from || ctx.from.is_bot || !ctx.chat) return false;
    const member = await this.bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return this.isInstanceAdmin(ctx.chat.id, member.user) && isActiveMember(member);
  }
  async reconcileConfiguration(): Promise<void> {
    await this.syncCommandMenus();
    for (const session of this.options.store.listSessions(this.id)) {
      if (!this.sessionAssigned(session)) {
        this.dropListener(session.id);
        this.topicIcons.delete(session.id);
        for (const [token, request] of this.capacityRequests) if (request.sessionId === session.id) this.capacityRequests.delete(token);
        for (const handler of this.sessionKillHandlers) handler(session.id);
      } else if (!this.stopped && session.status === 'open' && !this.listeners.has(session.id)) {
        const generation = this.options.store.getSessionGeneration(session.id);
        try {
          const running = this.options.store.hasPendingInitialTask(session.id) || await this.options.runtime.isRunning(session);
          if (running && this.sessionAssigned(session) && this.options.store.getSessionGeneration(session.id) === generation) await this.sendInitial(session);
        } catch (error) {
          if (!(error instanceof SessionCapacityError)) this.scheduleReconnect(session);
        }
      }
    }
  }
  private link(session: TopicSession): string {
    return `https://t.me/${this.bot.botInfo!.username}/${this.config.miniAppShortName}?startapp=s_${session.id}`;
  }
  private async getIconIds(): Promise<Record<TopicActivity, string>> {
    this.iconIds ??= (async () => {
      const controller = new TelegramAbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const stickers = await this.bot.telegram.callApi('getForumTopicIconStickers', {}, { signal: controller.signal });
        const find = (emoji: string) => {
          const id = stickers.find(sticker => sticker.emoji?.replace(/\uFE0F/g, '') === emoji)?.custom_emoji_id;
          if (!id) throw new Error(`Telegram topic icon unavailable: ${emoji}`);
          return id;
        };
        return { running: find('⚡'), completed: find('✅'), stopped: find('🏁') };
      } finally {
        clearTimeout(timeout);
      }
    })().catch(error => { this.iconIds = undefined; throw error; });
    return this.iconIds;
  }
  private setTopicStatus(session: TopicSession, status: TopicActivity): Promise<void> {
    if (this.stopped || !this.sessionAssigned(session)) return Promise.resolve();
    let icon = this.topicIcons.get(session.id);
    if (!icon) {
      icon = { tail: Promise.resolve() };
      this.topicIcons.set(session.id, icon);
    }
    if (icon.status === status) return icon.tail;
    icon.status = status;
    const current = icon;
    current.tail = current.tail.then(async () => {
      if (this.stopped || !this.sessionAssigned(session) || current.status !== status) return;
      const id = (await this.getIconIds())[status];
      if (!this.sessionAssigned(session)) return;
      if (this.options.store.getTopicIcon(session.id) === id) return;
      const applied = await this.delivery.run(session.chatId, async () => {
        const controller = new TelegramAbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          return await this.bot.telegram.callApi('editForumTopic', {
            chat_id:session.chatId, message_thread_id:session.threadId, icon_custom_emoji_id:id,
          }, {signal:controller.signal});
        } finally {
          clearTimeout(timeout);
        }
      }, () => !this.stopped && this.sessionAssigned(session) && current.status === status, true);
      if (applied !== undefined) this.options.store.setTopicIcon(session.id,id);
    }).catch(async error => {
      if (error instanceof TelegramError && error.description.includes('TOPIC_NOT_MODIFIED')) {
        this.options.store.setTopicIcon(session.id,(await this.getIconIds())[status]);
        return;
      }
      if (current.status === status) current.status = undefined;
      const reason = error instanceof TelegramError ? ` Telegram ${error.code}: ${error.description}` : '';
      console.warn(`Could not update topic status (${session.id}, ${status}).${reason}`);
    });
    return current.tail;
  }
  private async refreshTopicStatus(session: TopicSession): Promise<void> {
    if (!this.sessionAssigned(session)) return;
    const listener = this.listeners.get(session.id);
    const running = await this.options.runtime.isRunning(session);
    if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) return;
    if (!running) {
      this.dropListener(session.id);
      await this.setTopicStatus(session, 'stopped');
    } else if (listener?.connection) {
      await this.setTopicStatus(session, listener.activity);
    }
  }
  private async detachSession(session: TopicSession): Promise<void> {
    this.options.store.updateSession(session.id,{status:'detached'});
    this.options.store.advanceSessionGeneration(session.id);
    this.options.store.cancelInitialTask(session.id);
    this.dropListener(session.id);
    for (const [token, request] of this.capacityRequests) {
      if (request.sessionId === session.id) this.capacityRequests.delete(token);
    }
    for (const [token, proposal] of this.promptProposals) {
      if (proposal.sessionId === session.id) this.promptProposals.delete(token);
    }
    for (const handler of this.sessionKillHandlers) handler(session.id);
    const icon = this.topicIcons.get(session.id);
    await icon?.tail;
    this.topicIcons.delete(session.id);
    try {
      const applied = await this.delivery.run(session.chatId, () => this.bot.telegram.editForumTopic(
        session.chatId,session.threadId,{icon_custom_emoji_id:''}), () => !this.stopped &&
          this.options.store.getSession(session.id)?.status === 'detached' &&
          findInstance(this.options.config,this.id,session.chatId)?.path === session.instancePath);
      if (applied !== undefined) this.options.store.setTopicIcon(session.id,'');
    } catch (error) {
      if (!(error instanceof TelegramError && error.description.includes('TOPIC_NOT_MODIFIED'))) throw error;
      this.options.store.setTopicIcon(session.id,'');
    }
  }
  private async announce(session: TopicSession): Promise<void> {
    this.requireSessionAssignment(session);
    const message = await this.bot.telegram.sendMessage(session.chatId, `Open Session to view this topic. ${this.promptHelp(session.chatId)}`, { message_thread_id: session.threadId, reply_markup: { inline_keyboard: [[{ text: 'Open Session', url: this.link(session) }]] } });
    this.requireSessionAssignment(session);
    await this.bot.telegram.pinChatMessage(session.chatId, message.message_id, { disable_notification: true });
  }
  private async newSession(ctx: Context, task: string, attached?: { instanceId: string; sessionId: string; instancePath: string }, name?: string): Promise<void> {
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const instancePath = this.assignedPath(ctx.chat!.id);
    if (attached && attached.instancePath !== instancePath) throw new Error('The group instance assignment changed');
    const title = (name ?? task).replace(/\s+/g, ' ').trim().slice(0, 128) || 'OMP session';
    const topic = await this.bot.telegram.createForumTopic(ctx.chat!.id, title);
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    const session = this.options.store.createSession({ botId: this.id, chatId: ctx.chat!.id, threadId: topic.message_thread_id, instancePath }, title, attached ? { kind:'attached', instanceId:attached.instanceId, sessionId:attached.sessionId } : {kind:'managed'}, attached ? undefined : task, ctx.from!.id);
    if (task && ctx.message) this.options.store.setReplyTarget(session.id,ctx.message.message_id);
    await ctx.reply(`Topic created: https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`, {
      ...('message_thread_id' in ctx.message! ? { message_thread_id: ctx.message.message_thread_id } : {}),
      reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
    });
    await this.announce(session);
    if (task && ctx.message) await this.bot.telegram.forwardMessage(
      session.chatId, ctx.chat!.id, ctx.message.message_id, { message_thread_id: session.threadId });
    await this.setTopicStatus(session, 'stopped');
    await this.listen(session);
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    await this.sendInitial(session);
  }
  private async askTask(ctx: Context): Promise<void> {
    if (!(await this.instanceAdmin(ctx)) && !this.usersCanProposePrompts(ctx.chat!.id)) return;
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const name = ctx.from!.first_name;
    const message = await ctx.reply(`${name}, what should we work on? Reply to this message with the initial task.`, {
      entities: [{type:'text_mention',offset:0,length:name.length,user:ctx.from!}],
      reply_markup: {force_reply:true,selective:true,input_field_placeholder:'Describe the coding task'},
    });
    this.options.store.addTaskRequest(this.id, ctx.chat!.id, message.message_id, ctx.from!.id, ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id ?? 1 : 1);
  }
  private async setup(ctx: Context, setting?: 'all_messages_are_prompts' | 'users_can_propose_prompts', value?: boolean): Promise<void> {
    if (!ctx.chat || !ctx.from || ctx.from.is_bot || ctx.chat.type !== 'supergroup') return;
    const member = await this.bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (!isActiveMember(member) || member.user.is_bot) return;
    if (!(await this.ready(ctx.chat.id))) {
      await ctx.reply('Use a supergroup with Topics enabled, then grant this bot Manage Topics and Pin Messages permissions.', { reply_markup: { inline_keyboard: [[{text:'Check Again',callback_data:'setup:check'}]] } }); return;
    }
    const assigned = findInstance(this.options.config, this.id, ctx.chat.id);
    if (!assigned) {
      if (!isAdministrator(member)) { await ctx.reply('Only a current group administrator can request setup for an unassigned forum.'); return; }
      const request = this.options.store.createSetupRequest({ botId: this.id, chatId: ctx.chat.id, userId: member.user.id, ...(member.user.username ? { username: member.user.username.toLowerCase() } : {}), title: ctx.chat.title });
      const quotedPath = "'" + this.options.config.configPath.replaceAll("'", "'\\''") + "'";
      const command = `omp-telegram --config ${quotedPath} approve ${request.code}`;
      await ctx.reply(`Setup requested. Ask the local operator to approve within 10 minutes:\n${command}\nThe operator selects the instance directory locally.`, { entities: [{ type: 'code', offset: 'Setup requested. Ask the local operator to approve within 10 minutes:\n'.length, length: command.length }] });
      return;
    }
    if (!this.isInstanceAdmin(ctx.chat.id, member.user)) { await ctx.reply('Only a configured instance admin can enroll this group.'); return; }
    this.assignedPath(ctx.chat.id);
    if (setting !== undefined && value !== undefined) {
      if (!(this.options.configWritable?.() ?? configWritable(this.options.config.configPath))) {
        await ctx.reply(`Configuration is read-only. Ask the local operator to set ${setting} for this bot/chat assignment.`);
        return;
      }
      const persisted = readConfig(this.options.config.configPath);
      const current = findInstance(persisted, this.id, ctx.chat.id);
      if (!current || current.path !== assigned.path || !member.user.username ||
          !current.instance.admins.includes(member.user.username.toLowerCase())) {
        await ctx.reply('The configured instance assignment or administrator access changed. Run /setup again.');
        return;
      }
      const chat = current.instance.chats.find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)!;
      chat[setting] = value;
      writeConfig(persisted);
      assigned.instance.chats.find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)![setting] = value;
      await this.syncCommandMenus();
    }
    this.options.store.enrollGroup(this.id, ctx.chat.id);
    await ctx.reply(`Ready. Every new topic becomes an OMP session.\n${this.promptHelp(ctx.chat.id)}\nChoose prompt settings:`, { reply_markup: { inline_keyboard: [
      [{text:'All messages',callback_data:'setup:prompts:true'},{text:'Only /p',callback_data:'setup:prompts:false'}],
      [{text:'Allow user proposals',callback_data:'setup:proposals:true'},{text:'Ignore non-admin prompts',callback_data:'setup:proposals:false'}],
      [{text:'New Session',callback_data:'session:new'}],[{text:'Check Again',callback_data:'setup:check'}],
    ] } });
  }
  async requestCapacity(session: TopicSession, limit: number): Promise<void> {
    if (!this.sessionAssigned(session)) return;
    if (!(this.options.configWritable?.() ?? configWritable(this.options.config.configPath))) {
      const command = `omp-telegram --config '${this.options.config.configPath.replaceAll("'", "'\\''")}' configure`;
      await this.bot.telegram.sendMessage(session.chatId, `OMP session limit reached (${limit}). Configuration is read-only; ask the local operator to change its source or permissions, then run:\n${command}`, { message_thread_id: session.threadId });
      return;
    }
    const now = Date.now();
    for (const [token, request] of this.capacityRequests) {
      if (request.expires <= now || (request.sessionId === session.id && request.limit !== limit)) this.capacityRequests.delete(token);
      else if (request.sessionId === session.id) return;
    }
    const token = randomBytes(16).toString('base64url');
    const message = await this.bot.telegram.sendMessage(session.chatId,
      `OMP session limit reached (${limit}). Increase the shared configured limit from ${limit} to ${limit * 2}? Confirmation by an instance admin is required. Approval saves the configuration, reconnects this topic and submits any pending initial task. Other instructions must be resent. This request expires in 5 minutes.`,
      { message_thread_id: session.threadId, reply_markup: { inline_keyboard: [[
        { text: `Confirm ${limit} → ${limit * 2}`, callback_data: `capacity:approve:${token}` },
        { text: 'Cancel', callback_data: `capacity:cancel:${token}` },
      ]] } });
    this.capacityRequests.set(token, {sessionId:session.id,chatId:session.chatId,threadId:session.threadId,messageId:message.message_id,limit,expires:now+300000});
  }
  private async confirmCapacity(ctx: Context, action: string, token: string): Promise<void> {
    const request = this.capacityRequests.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!request || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== request.chatId || message.message_id !== request.messageId ||
        !('message_thread_id' in message) || message.message_thread_id !== request.threadId ||
        !('from' in message) || message.from?.id !== this.id ||
        'forward_origin' in message || 'forward_date' in message) return;
    if (request.expires <= Date.now()) {
      this.capacityRequests.delete(token);
      await ctx.reply('This capacity request expired. Send a prompt in the topic to request another confirmation.');
      return;
    }
    if (!(await this.instanceAdmin(ctx))) {
      await ctx.reply('Only a configured instance admin can confirm or cancel a capacity increase.');
      return;
    }
    await this.authorize(request.chatId,ctx.from!.id);
    this.capacityRequests.delete(token);
    if (action === 'cancel') {
      await ctx.reply('Capacity increase cancelled. The session limit is unchanged.');
      return;
    }
    const session = this.options.store.getSession(request.sessionId);
    if (!session || !this.sessionAssigned(session) || session.status !== 'open' || session.chatId !== request.chatId || session.threadId !== request.threadId) return;
    if (!(this.options.configWritable?.() ?? configWritable(this.options.config.configPath))) {
      const command = `omp-telegram --config '${this.options.config.configPath.replaceAll("'", "'\\''")}' configure`;
      await ctx.reply(`Configuration is read-only. The session limit is unchanged. Ask the local operator to change its source or permissions, then run:\n${command}`);
      return;
    }
    const member = await this.bot.telegram.getChatMember(request.chatId, ctx.from!.id);
    const persisted = readConfig(this.options.config.configPath);
    const assigned = findInstance(persisted, this.id, request.chatId);
    if (!isActiveMember(member) || member.user.is_bot || !member.user.username || !assigned ||
        assigned.path !== session.instancePath || !assigned.instance.admins.includes(member.user.username.toLowerCase())) {
      await ctx.reply('The configured instance assignment or administrator access changed. The session limit is unchanged.');
      return;
    }
    if (this.options.runtime.getSessionLimit() !== request.limit || persisted.omp.maxSessions !== request.limit) {
      await ctx.reply('The session limit changed. This confirmation is stale; send a prompt to request another confirmation if needed.');
      return;
    }
    writeConfig({ ...persisted, omp: { ...persisted.omp, maxSessions: request.limit * 2 } });
    this.options.config.omp.maxSessions = request.limit * 2;
    this.options.runtime.increaseSessionLimit(request.limit);
    await ctx.reply(`Configured session limit increased from ${request.limit} to ${request.limit * 2}. Reconnecting this topic.`).catch(() => undefined);
    await this.listen(session);
    await this.sendInitial(session);
  }
  private async routePrompt(ctx: Context, text: string, session?: TopicSession): Promise<void> {
    const admin = await this.instanceAdmin(ctx);
    if (!admin && !this.usersCanProposePrompts(ctx.chat!.id)) return;
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    await this.receiveMessage(ctx,true);
    if (session) {
      this.requireSessionAssignment(session);
      if (session.status !== 'open') { await ctx.reply('This session is archived. Reopen the topic before sending instructions.'); return; }
    }
    if (admin) {
      if (session) await this.submitSessionPrompt(ctx, session, text);
      else await this.newSession(ctx, text);
      return;
    }
    const now = Date.now();
    for (const [token, proposal] of this.promptProposals) if (proposal.expires <= now) this.promptProposals.delete(token);
    const token = randomBytes(16).toString('base64url');
    const instancePath = this.assignedPath(ctx.chat!.id);
    const author = ctx.from!.username ? `@${ctx.from!.username}` : `${ctx.from!.first_name} (user ID ${ctx.from!.id})`;
    const body = `${author} proposed a prompt:\n${text}`;
    for (let offset = 0; offset < body.length;) {
      let end = Math.min(offset+4000,body.length);
      if (end < body.length && body.charCodeAt(end-1) >= 0xD800 && body.charCodeAt(end-1) <= 0xDBFF) end--;
      if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
      await ctx.reply(body.slice(offset,end), {
        ...('message_thread_id' in ctx.message! ? {message_thread_id:ctx.message.message_thread_id} : {}),
      });
      offset = end;
    }
    const message = await ctx.reply('Prompt proposed. An instance admin must approve it before it runs. Approval expires in 10 minutes.', {
      ...('message_thread_id' in ctx.message! ? {message_thread_id:ctx.message.message_thread_id} : {}),
      reply_parameters:{message_id:ctx.message!.message_id,allow_sending_without_reply:true},
      reply_markup:{inline_keyboard:[[{text:'Approve prompt',callback_data:`prompt:approve:${token}`}]]},
    });
    this.promptProposals.set(token, {
      source:ctx,text,instancePath,
      ...(session ? {sessionId:session.id,generation:this.options.store.getSessionGeneration(session.id)} : {}),
      allMessagesArePrompts:this.allMessagesArePrompts(ctx.chat!.id),messageId:message.message_id,expires:now+600000,
    });
  }
  private async approvePrompt(ctx: Context, token: string): Promise<void> {
    const proposal = this.promptProposals.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!proposal || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== proposal.source.chat!.id || message.message_id !== proposal.messageId ||
        ('message_thread_id' in message ? message.message_thread_id ?? 1 : 1) !==
          (proposal.source.message && 'message_thread_id' in proposal.source.message ? proposal.source.message.message_thread_id ?? 1 : 1) ||
        !('from' in message) || message.from?.id !== this.id || 'forward_origin' in message || 'forward_date' in message) return;
    if (!(await this.instanceAdmin(ctx))) { await ctx.reply('Only an instance admin can approve prompts.'); return; }
    await this.authorize(ctx.chat.id, ctx.from!.id);
    const session = proposal.sessionId ? this.options.store.getSession(proposal.sessionId) : undefined;
    if (proposal.expires <= Date.now() || !this.usersCanProposePrompts(ctx.chat.id) ||
        this.allMessagesArePrompts(ctx.chat.id) !== proposal.allMessagesArePrompts ||
        findInstance(this.options.config,this.id,ctx.chat.id)?.path !== proposal.instancePath ||
        (proposal.sessionId && (!session || !this.sessionAssigned(session) || session.status !== 'open' ||
          this.options.store.getSessionGeneration(proposal.sessionId) !== proposal.generation))) {
      this.promptProposals.delete(token);
      await ctx.editMessageText('This prompt proposal is no longer active.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    await this.authorize(ctx.chat.id, proposal.source.from!.id);
    this.promptProposals.delete(token);
    await ctx.editMessageReplyMarkup({inline_keyboard:[]});
    if (session) {
      if (!(await this.submitSessionPrompt(proposal.source,session,proposal.text))) {
        await ctx.editMessageText('Prompt not submitted: the initial task is still being admitted. Propose it again after startup.');
        return;
      }
    } else await this.newSession(proposal.source,proposal.text);
    await ctx.editMessageText('Prompt approved.',{reply_markup:{inline_keyboard:[]}});
  }
  private async submitSessionPrompt(ctx: Context, session: TopicSession, prompt: string): Promise<boolean> {
    await this.authorize(ctx.chat!.id,ctx.from!.id);
    this.requireSessionAssignment(session);
    await this.listen(session);
    await this.authorize(ctx.chat!.id,ctx.from!.id);
    if (this.listeners.get(session.id)?.initial) {
      await ctx.reply('The initial task is still being admitted. Wait for the host to start before sending another instruction.');
      return false;
    }
    const previousTarget = this.options.store.getReplyTarget(session.id);
    const messageId = ctx.message!.message_id;
    this.options.store.setReplyTarget(session.id,messageId);
    try {
      this.sendPrompt(this.listeners.get(session.id)!,prompt,messageId);
    } catch (error) {
      this.options.store.setReplyTarget(session.id,previousTarget);
      throw error;
    }
    return true;
  }
  private async handle(ctx: Context): Promise<void> {
    if (this.stopped) return;
    if (ctx.callbackQuery) {
      if (!('data' in ctx.callbackQuery) || !ctx.chat || !ctx.from || ctx.from.is_bot) return;
      if (ctx.callbackQuery.data === 'setup:check') await this.setup(ctx);
      const promptMode = ctx.callbackQuery.data.match(/^setup:(prompts|proposals):(true|false)$/);
      if (promptMode && 'message' in ctx.callbackQuery) {
        const message = ctx.callbackQuery.message;
        if (message && 'from' in message && message.from?.id === this.id && !('forward_origin' in message) && !('forward_date' in message)) {
          await this.setup(ctx, promptMode[1] === 'prompts' ? 'all_messages_are_prompts' : 'users_can_propose_prompts', promptMode[2] === 'true');
        }
      }
      if (ctx.callbackQuery.data === 'session:new') await this.askTask(ctx);
      const proposal = ctx.callbackQuery.data.match(/^prompt:approve:([A-Za-z0-9_-]{22})$/);
      if (proposal) await this.approvePrompt(ctx,proposal[1]!);
      const capacity = ctx.callbackQuery.data.match(/^capacity:(approve|cancel):([A-Za-z0-9_-]{22})$/);
      if (capacity) await this.confirmCapacity(ctx,capacity[1]!,capacity[2]!);
      const answer = ctx.callbackQuery.data.match(/^ask:([A-Za-z0-9_-]{16}):(\d+|cancel)$/);
      if (answer) await this.answerQuestion(ctx, answer[1]!, answer[2]!);
      return;
    }
    if (ctx.myChatMember) {
      if (ctx.chat && ['administrator','member'].includes(ctx.myChatMember.new_chat_member.status)) await ctx.reply('A current group administrator can run /setup to request instance assignment from the local operator.');
      return;
    }
    const message = ctx.message;
    if (!message || !ctx.chat) return;
    const topicLifecycle = 'forum_topic_created' in message || 'forum_topic_edited' in message || 'forum_topic_closed' in message || 'forum_topic_reopened' in message;
    if ('forward_origin' in message || 'forward_date' in message || (ctx.from?.is_bot && !topicLifecycle)) return;
    const text = 'text' in message ? message.text : undefined;
    if (text && !text.startsWith('/') && this.options.store.getTopic({
      botId:this.id,chatId:ctx.chat.id,threadId:message.message_thread_id ?? 1,
    })?.status === 'detached') {
      if (ctx.from && 'reply_to_message' in message && message.reply_to_message &&
          this.options.store.takeTaskRequest(this.id,ctx.chat.id,message.reply_to_message.message_id,ctx.from.id)) {
        await this.routePrompt(ctx,text);
      }
      return;
    }
    if (ctx.from && !ctx.from.is_bot && text && 'reply_to_message' in message && message.reply_to_message?.from?.id === this.id) {
      const replyId = message.reply_to_message.message_id;
      const question = [...this.questions.entries()].find(([, pending]) =>
        pending.session.chatId === ctx.chat!.id && pending.session.threadId === message.message_thread_id &&
        pending.messageIds.includes(replyId));
      if (question) {
        const [token, pending] = question;
        await this.delivery.run(ctx.chat.id, () => this.authorize(ctx.chat!.id,ctx.from!.id),
          () => !this.stopped && this.questions.get(token) === pending);
        await this.receiveMessage(ctx, true);
        if (pending.request.kind === 'editor') this.submitAnswer(token,text,undefined,message.message_id);
        else await ctx.reply('Use the numbered answer buttons on the question.');
        return;
      }
      if (this.endedQuestionReplies.has(`${ctx.chat.id}:${replyId}`)) {
        await this.authorize(ctx.chat.id, ctx.from.id);
        await ctx.reply('This question is no longer active. Answer the latest question instead.');
        return;
      }
    }
    const command = text?.match(/^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (command?.[2] && command[2].toLowerCase() !== this.bot.botInfo!.username.toLowerCase()) return;
    if (ctx.chat.type === 'private') {
      const instances = Object.values(this.options.config.instances).filter(instance => instance.chats.some(chat => chat.botId === this.id));
      const allowed = ctx.from?.username && instances.some(instance => instance.admins.includes(ctx.from!.username!.toLowerCase()));
      if (instances.length && !allowed) { await ctx.reply('This bot is managed by its configured instance admins. Ask the local operator for access.'); return; }
      await ctx.reply('Add me to your own supergroup, enable Topics, grant Manage Topics and Pin Messages, then run /setup. Configure the Mini App URL in BotFather for this bot.', {reply_markup:{inline_keyboard:[[{text:'Add to Group',url:`https://t.me/${this.bot.botInfo!.username}?startgroup=setup&admin=manage_topics+pin_messages`}]]}}); return;
    }
    if (command?.[1]?.toLowerCase() === 'setup') { await this.setup(ctx); return; }
    const assigned = findInstance(this.options.config, this.id, ctx.chat.id);
    if (!assigned || !this.options.store.isEnrolled(this.id, ctx.chat.id)) {
      if (command?.[1]?.toLowerCase() === 'status') {
        await ctx.reply(`${await this.ready(ctx.chat.id) ? 'Forum permissions ready.' : 'Enable Topics in a supergroup and grant Manage Topics and Pin Messages.'} Run /setup as an instance admin to enroll an assigned group, or as a group administrator to request assignment.`);
      } else if (command?.[1]?.toLowerCase() === 'help') {
        await ctx.reply(`${help}\n${this.promptHelp(ctx.chat.id)}`);
      }
      return;
    }
    const threadId = 'message_thread_id' in message ? message.message_thread_id ?? 1 : 1;
    const key = {botId:this.id,chatId:ctx.chat.id,threadId,instancePath:this.assignedPath(ctx.chat.id)};
    let session = this.options.store.getTopic(key);
    const detached = session?.status === 'detached';
    if (session && !detached) this.requireSessionAssignment(session);
    if (detached && topicLifecycle && !('forum_topic_edited' in message)) return;
    if ('forum_topic_created' in message && threadId !== 1) {
      if (!session) {
        session = this.options.store.createSession(key, message.forum_topic_created.name);
        await this.announce(session);
        await this.setTopicStatus(session, 'stopped');
      }
      return;
    }
    if (session && 'forum_topic_edited' in message) {
      const edited = message.forum_topic_edited;
      if (edited.name) this.options.store.updateSession(session.id, {name:edited.name});
      if (edited.icon_custom_emoji_id !== undefined) {
        this.options.store.setTopicIcon(session.id,edited.icon_custom_emoji_id);
        if (ctx.from?.id !== this.id) {
          const icon = this.topicIcons.get(session.id);
          if (icon) icon.status = undefined;
        }
      }
      if (ctx.from?.id === this.id && edited.icon_custom_emoji_id !== undefined && edited.name === undefined) {
        await this.delivery.run(ctx.chat.id,
          () => this.bot.telegram.deleteMessage(ctx.chat!.id,message.message_id),
          () => !this.stopped && (detached
            ? this.options.store.getSession(session.id)?.status === 'detached' &&
              findInstance(this.options.config,this.id,session.chatId)?.path === session.instancePath
            : this.sessionAssigned(session))).catch(() => {
          console.warn(`Could not delete topic icon notice (${session.id}, ${message.message_id}).`);
        });
      }
      return;
    }
    if (session && 'forum_topic_closed' in message) {
      this.options.store.updateSession(session.id, {status:'closed'});
      const listener = this.listeners.get(session.id);
      clearTimeout(listener?.initial?.timer);
      if (listener) listener.initial = undefined;
      await this.options.runtime.stop(session.id);
      await this.refreshTopicStatus(session);
      return;
    }
    if (session && 'forum_topic_reopened' in message) {
      this.options.store.updateSession(session.id,{status:'open'});
      await this.refreshTopicStatus(session);
      return;
    }
    if (!ctx.from || ctx.from.is_bot || !text || 'forward_origin' in message || 'forward_date' in message) return;
    const allMessagesArePrompts = this.allMessagesArePrompts(ctx.chat.id);
    let prompt = '';
    if (command) {
      await this.authorize(ctx.chat.id, ctx.from.id);
      const action = command[1]!.toLowerCase(), arg = command[3]?.trim() ?? '';
      if (action === 'detach') {
        if (!(await this.instanceAdmin(ctx))) { await ctx.reply('Detaching requires a configured instance admin.'); return; }
        if (threadId === 1 || !session) { await ctx.reply('Use /detach inside a session topic, not General or an unrelated chat.'); return; }
        await this.detachSession(session);
        await ctx.reply('This topic is now conversation-only. Session links, prompts, and mirroring are disabled. Host history is preserved; the host was not killed.');
        return;
      }
      if (detached && !['new','attach','help','start'].includes(action)) {
        await ctx.reply('This topic is conversation-only. Use /new to create a separate session topic.');
        return;
      }
      if ((action === 'new' || action === 'p') && !this.usersCanProposePrompts(ctx.chat.id) && !(await this.instanceAdmin(ctx))) return;
      if (action === 'new' || (action === 'p' && threadId === 1)) { if (arg) await this.routePrompt(ctx,arg); else await this.askTask(ctx); return; }
      if (action === 'attach') {
        if (!(await this.instanceAdmin(ctx))) { await ctx.reply('Attaching requires a configured instance admin.'); return; }
        const match = arg.match(/^([A-Za-z0-9_-]+)(?:\s+(.+))?$/);
        if (!match) { await ctx.reply('Usage: /attach instanceId [topic name]. Get the instance ID from omp collab list.'); return; }
        const instancePath = this.assignedPath(ctx.chat.id);
        const binding = await this.options.runtime.attach(match[1]!, instancePath);
        await this.newSession(ctx,'',{instanceId:binding.instanceId,sessionId:binding.sessionId,instancePath},match[2] ?? 'Attached OMP session'); return;
      }
      if (action === 'help' || action === 'start') { await ctx.reply(`${help}\n${this.promptHelp(ctx.chat.id)}`); return; }
      if (action === 'status') { await ctx.reply(`${await this.ready(ctx.chat.id) ? 'Forum ready.' : 'Forum permissions need attention.'}${session ? `\nSession: ${session.name} (${session.status})` : '\nUse /new task to create a session.'}`); return; }
      if (action === 'session') {
        if (!session) { await ctx.reply('No session in this topic. Use /new task or create a topic.'); return; }
        await ctx.reply(`${session.name} (${session.status})`,{reply_markup:{inline_keyboard:[[{text:'Open Session',url:this.link(session)}]]}}); return;
      }
      if (action === 'model_preset' || action === 'list_model_presets') {
        if (!(await this.instanceAdmin(ctx))) { await ctx.reply('Model preset commands require a configured instance admin.'); return; }
        if (threadId !== 1 && !session) { await ctx.reply(`Use /${action} in General or a session topic.`); return; }
        if (session && session.status !== 'open') { await ctx.reply('This session is archived. Reopen the topic before using model preset commands.'); return; }
        if (action === 'model_preset' ? !/^[A-Za-z][\w-]*$/.test(arg) : Boolean(arg)) {
          await ctx.reply(action === 'model_preset' ? 'Usage: /model_preset <name> (a letter, then letters, digits, - or _)' : 'Usage: /list_model_presets');
          return;
        }
        if (threadId === 1) {
          const instancePath = assigned.path;
          const names = await this.options.runtime.availableModelPresets(instancePath);
          await this.authorize(ctx.chat.id,ctx.from.id);
          if (!(await this.instanceAdmin(ctx))) { await ctx.reply('Model preset commands require a configured instance admin.'); return; }
          if (this.assignedPath(ctx.chat.id) !== instancePath) throw new Error('The group instance assignment changed');
          if (action === 'model_preset') {
            if (!names.includes(arg)) throw new Error(`Unknown model preset: ${arg}. Available presets: ${names.join(', ') || '(none)'}`);
            const member = await this.bot.telegram.getChatMember(ctx.chat.id,ctx.from.id);
            const persisted = readConfig(this.options.config.configPath);
            const current = findInstance(persisted,this.id,ctx.chat.id);
            if (!current || current.path !== instancePath || !isActiveMember(member) || member.user.is_bot ||
                !member.user.username || !current.instance.admins.includes(member.user.username.toLowerCase())) {
              throw new Error('The configured instance assignment or administrator access changed. The default model preset is unchanged.');
            }
            const chat = current.instance.chats.find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)!;
            chat.default_model_preset = arg;
            writeConfig(persisted);
            const active = findInstance(this.options.config,this.id,ctx.chat.id)!.instance.chats
              .find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)!;
            active.default_model_preset = arg;
            await ctx.reply(`Default model preset: ${arg}. Managed sessions will use it when their host starts. Running hosts are unchanged.`);
          } else {
            const preset = findInstance(this.options.config,this.id,ctx.chat.id)!.instance.chats
              .find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)?.default_model_preset;
            const text = `${names.length ? `Model presets: ${names.join(', ')}` : 'No model presets saved. Use /modelpreset save <name> to create one.'}\nDefault model preset: ${preset ?? '(not set)'}`;
            for (let offset = 0; offset < text.length; offset += 4000) await ctx.reply(text.slice(offset,offset+4000));
          }
          return;
        }
        if (!session) return;
        const generation = this.options.store.getSessionGeneration(session.id);
        const release = this.options.runtime.retain(session.id);
        try {
          await this.options.runtime.ensure(session);
          await this.authorize(ctx.chat.id,ctx.from.id);
          if (!(await this.instanceAdmin(ctx))) { await ctx.reply('Model preset commands require a configured instance admin.'); return; }
          this.requireSessionAssignment(session);
          if (this.options.store.getSessionGeneration(session.id) !== generation ||
              this.options.store.getSession(session.id)?.status !== 'open') throw new Error('The session changed before the model preset command could run');
          let text = await this.options.runtime.modelPresets(session,action === 'model_preset' ? arg : undefined);
          if (action === 'list_model_presets') {
            const preset = findInstance(this.options.config,this.id,ctx.chat.id)!.instance.chats
              .find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)?.default_model_preset;
            text += `\nDefault model preset: ${preset ?? '(not set)'}`;
          }
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(offset+4000,text.length);
            if (end < text.length && text.charCodeAt(end-1) >= 0xD800 && text.charCodeAt(end-1) <= 0xDBFF) end--;
            await ctx.reply(text.slice(offset,end));
            offset = end;
          }
        } finally { release(); }
        return;
      }
      if (action === 'stop' || action === 'kill') {
        if (threadId === 1 || !session) { await ctx.reply(`Use /${action} inside a session topic, not General or an unrelated chat.`); return; }
        this.requireSessionAssignment(session);
        if (action === 'stop' && session.status !== 'open') { await ctx.reply('This session is archived. Reopen the topic before sending instructions.'); return; }
        this.options.store.cancelInitialTask(session.id);
        const listener = this.listeners.get(session.id);
        clearTimeout(listener?.initial?.timer);
        if (listener) listener.initial = undefined;
        for (const [token, request] of this.capacityRequests) {
          if (request.sessionId === session.id) this.capacityRequests.delete(token);
        }
        if (action === 'kill') {
          this.options.store.advanceSessionGeneration(session.id);
          this.dropListener(session.id);
          for (const handler of this.sessionKillHandlers) handler(session.id);
          await this.options.runtime.kill(session);
          this.acknowledgeMessage(session,message.message_id);
          await this.setTopicStatus(session, 'stopped');
          await ctx.reply('Session process killed. History is preserved; a managed session can restart on your next instruction or Open Session visit.');
          return;
        }
        if (!(await this.options.runtime.isRunning(session))) {
          this.dropListener(session.id);
          await this.setTopicStatus(session, 'stopped');
          await ctx.reply('Session is not running.');
          return;
        }
        const connection = await this.listen(session);
        await this.authorize(ctx.chat.id, ctx.from.id);
        this.requireSessionAssignment(session);
        const activeListener = this.listeners.get(session.id)!;
        activeListener.pendingAnswers.clear();
        activeListener.pendingStops.push(message.message_id);
        try {
          connection.send({t:'abort'});
        } catch (error) {
          const index = activeListener.pendingStops.indexOf(message.message_id);
          if (index !== -1) activeListener.pendingStops.splice(index,1);
          throw error;
        }
        await ctx.reply('Abort requested. The session process is still running.');
        return;
      }
      if (action !== 'p' || allMessagesArePrompts) return;
      if (!session) { await ctx.reply('Use /p inside a session topic, or in General to create a new session.'); return; }
      if (!arg) { await ctx.reply('Usage: /p <prompt>'); return; }
      prompt = arg;
    } else {
      if ('reply_to_message' in message && message.reply_to_message && this.options.store.takeTaskRequest(this.id,ctx.chat.id,message.reply_to_message.message_id,ctx.from.id)) {
        await this.routePrompt(ctx,text);
        return;
      }
      if (!allMessagesArePrompts || !session) return;
      const entities = 'entities' in message ? message.entities ?? [] : [];
      const mentions = entities.filter(entity =>
        (entity.type === 'mention' && text.slice(entity.offset,entity.offset+entity.length).toLowerCase() === `@${this.bot.botInfo!.username.toLowerCase()}`) ||
        (entity.type === 'text_mention' && entity.user.id === this.id),
      );
      prompt = text;
      for (const entity of [...mentions].reverse()) prompt = prompt.slice(0,entity.offset) + prompt.slice(entity.offset+entity.length);
      prompt = prompt.trim();
    }
    if (!session) return;
    if (prompt) await this.routePrompt(ctx,prompt,session);
  }
  private scheduleReconnect(session: TopicSession, attempt = 0): void {
    if (this.stopped || !this.sessionAssigned(session)) return;
    const current = this.options.store.getSession(session.id);
    if (current?.status !== 'open' || this.reconnects.has(session.id)) return;
    if (attempt >= 5) {
      void this.bot.telegram.sendMessage(session.chatId, `Session mirroring disconnected. Send a prompt to reconnect to the local host. ${this.promptHelp(session.chatId)}`, { message_thread_id: session.threadId }).catch(() => undefined);
      return;
    }
    const generation = this.options.store.getSessionGeneration(session.id);
    const timer = setTimeout(() => {
      this.reconnects.delete(session.id);
      if (this.stopped || !this.sessionAssigned(session) || this.options.store.getSessionGeneration(session.id) !== generation) return;
      const active = this.options.store.getSession(session.id);
      if (active?.status !== 'open') return;
      void this.options.runtime.isRunning(active).then(async running => {
        if (this.stopped || !this.sessionAssigned(active) || this.options.store.getSessionGeneration(active.id) !== generation) return;
        if (!this.stopped && running && this.options.store.getSession(active.id)?.status === 'open') await this.sendInitial(active);
        if (!running) await this.setTopicStatus(active, 'stopped');
      }).catch(error => {
        if (!this.stopped && !(error instanceof SessionCapacityError) && this.options.store.getSessionGeneration(active.id) === generation) this.scheduleReconnect(active, attempt + 1);
      });
    }, Math.min(1000 * 2 ** attempt, 16000));
    timer.unref();
    this.reconnects.set(session.id, timer);
  }
  private dropListener(id: string): void {
    clearTimeout(this.reconnects.get(id));
    this.reconnects.delete(id);
    const listener = this.listeners.get(id);
    this.listeners.delete(id);
    clearTimeout(listener?.initial?.timer);
    for (const [token, question] of this.questions) {
      if (question.listener === listener) this.endQuestion(token);
    }
    listener?.connection?.close();
  }
  private listen(session: TopicSession, binding?: HostBinding): Promise<CollabConnection> {
    this.requireSessionAssignment(session);
    const existing = this.listeners.get(session.id);
    if (existing?.promise) return existing.promise;
    const listener: Listener = {sessionId:session.id,tail:Promise.resolve(),queued:0,recovering:this.options.store.hasSnapshot(session.id),pendingPrompts:[],pendingAnswers:new Map(),pendingStops:[],queuedMessages:0,activity:'completed'};
    this.listeners.set(session.id, listener);
    listener.promise = (binding ? Promise.resolve(binding) : this.options.runtime.ensure(session)).then(binding => {
      this.requireSessionAssignment(session);
      return (this.options.connect ?? connectCollab)(binding,`Telegram @${this.bot.botInfo!.username}`,{
      onFrame: frame => this.onFrame(session,listener,frame),
      onClose: () => {
        if (this.listeners.get(session.id) !== listener) return;
        const connected = listener.connection !== undefined;
        this.dropListener(session.id);
        void this.refreshTopicStatus(session).catch(() => undefined);
        if (connected) this.scheduleReconnect(session);
      },
    }); }).then(connection => {
      if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) { connection.close(); throw new Error('Session closed'); }
      listener.connection = connection; return connection;
    }).catch(async error => {
      try {
        if (error instanceof SessionCapacityError && !this.stopped) await this.requestCapacity(session,error.limit);
        throw error;
      } finally {
        if (this.listeners.get(session.id) === listener) this.listeners.delete(session.id);
        await this.refreshTopicStatus(session).catch(() => undefined);
      }
    });
    return listener.promise;
  }
  private sendPrompt(listener: Listener, text: string, messageId?: number): void {
    const session = this.options.store.getSession(listener.sessionId);
    if (!session) throw new Error('Session no longer exists');
    this.requireSessionAssignment(session);
    const pending = {text,messageId};
    listener.pendingPrompts.push(pending);
    try {
      this.options.runtime.markPrompt(listener.sessionId);
      listener.connection!.send({t:'prompt',text});
    } catch (error) {
      const index = listener.pendingPrompts.indexOf(pending);
      if (index !== -1) listener.pendingPrompts.splice(index,1);
      throw error;
    }
  }
  private async sendInitial(session: TopicSession): Promise<void> {
    this.requireSessionAssignment(session);
    await this.listen(session);
    const userId = this.options.store.getInitialUser(session.id);
    if (!userId) return;
    await this.authorize(session.chatId,userId);
    this.requireSessionAssignment(session);
    if (!this.options.store.hasPendingInitialTask(session.id)) return;
    this.options.runtime.markPrompt(session.id);
    const task = this.options.store.claimInitialTask(session.id);
    if (!task) return;
    const listener = this.listeners.get(session.id)!;
    const messageId = this.options.store.getReplyTarget(session.id);
    listener.initial = {text:task,userId,messageId,deadline:Date.now()+this.options.config.omp.startupTimeoutMs,retries:0,phase:'sent'};
    listener.initial.timer = setTimeout(() => { listener.initial = undefined; },this.options.config.omp.startupTimeoutMs);
    listener.initial.timer.unref();
    this.sendPrompt(listener,task,messageId);
  }
  private acknowledgeMessage(session: TopicSession, messageId: number, listener?: Listener): void {
    void this.delivery.run(session.chatId,
      () => this.bot.telegram.setMessageReaction(session.chatId,messageId,[{type:'emoji',emoji:'🤝'}]),
      () => !this.stopped && this.sessionAssigned(session) && (listener === undefined || this.listeners.get(session.id) === listener)).catch(() => undefined);
  }
  private endQuestion(token: string): void {
    const question = this.questions.get(token);
    if (!question) return;
    this.questions.delete(token);
    for (const messageId of question.messageIds) {
      this.endedQuestionReplies.add(`${question.session.chatId}:${messageId}`);
    }
    while (this.endedQuestionReplies.size > 512) this.endedQuestionReplies.delete(this.endedQuestionReplies.values().next().value!);
    const answer = question.answer;
    const receiptId = answer === undefined ? undefined : question.buttonIds[0];
    for (const messageId of question.buttonIds) {
      if (messageId !== receiptId) {
        void this.delivery.run(question.session.chatId,
          () => this.bot.telegram.editMessageReplyMarkup(question.session.chatId,messageId,undefined,{inline_keyboard:[]}),
          () => !this.stopped && this.sessionAssigned(question.session)).catch(() => undefined);
      }
    }
    if (answer !== undefined) {
      question.listener.tail = question.listener.tail.then(async () => {
        for (let offset = 0; offset < answer.length;) {
          if (this.stopped || !this.sessionAssigned(question.session)) return;
          let end = Math.min(offset+4000, answer.length);
          if (end < answer.length && answer.charCodeAt(end-1) >= 0xD800 && answer.charCodeAt(end-1) <= 0xDBFF) end--;
          const text = answer.slice(offset,end);
          if (offset === 0 && receiptId !== undefined) {
            await this.delivery.run(question.session.chatId,
              () => this.bot.telegram.editMessageText(question.session.chatId,receiptId,undefined,text,{reply_markup:{inline_keyboard:[]}}),
              () => !this.stopped && this.sessionAssigned(question.session));
          } else {
            await this.delivery.run(question.session.chatId,
              () => this.bot.telegram.sendMessage(question.session.chatId,text,{
                message_thread_id:question.session.threadId,
                ...(receiptId === undefined ? {} : {reply_parameters:{message_id:receiptId,allow_sending_without_reply:true}}),
              }), () => !this.stopped && this.sessionAssigned(question.session));
          }
          offset = end;
        }
      }).catch(error => { console.warn(`Could not show question answer (${question.session.id}).`, error); });
    }
  }
  private submitAnswer(token: string, value?: string, receipt?: string, messageId?: number): void {
    const question = this.questions.get(token);
    if (!question || this.stopped || this.listeners.get(question.session.id) !== question.listener ||
        !this.sessionAssigned(question.session) || this.options.store.getSession(question.session.id)?.status !== 'open') return;
    question.answer = receipt ?? (value === undefined ? 'Question cancelled.' : 'Custom answer sent.');
    if (messageId !== undefined) question.listener.pendingAnswers.set(question.request.reqId,messageId);
    try {
      question.listener.connection!.send({t:'ui-response',reqId:question.request.reqId,value});
    } catch (error) {
      question.answer = undefined;
      question.listener.pendingAnswers.delete(question.request.reqId);
      throw error;
    }
    this.endQuestion(token);
  }
  private async answerQuestion(ctx: Context, token: string, choice: string): Promise<void> {
    const question = this.questions.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!question || !message || !ctx.chat || !ctx.from || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== question.session.chatId || !question.buttonIds.includes(message.message_id) ||
        !('message_thread_id' in message) || message.message_thread_id !== question.session.threadId ||
        !('from' in message) || message.from?.id !== this.id || 'forward_origin' in message || 'forward_date' in message) {
      await ctx.answerCbQuery('This question is no longer active.');
      return;
    }
    await this.delivery.run(ctx.chat.id, () => this.authorize(ctx.chat!.id,ctx.from!.id),
      () => !this.stopped && this.questions.get(token) === question);
    if (choice === 'cancel') this.submitAnswer(token);
    else if (question.request.kind === 'select') {
      const option = question.request.options[Number(choice)];
      if (option === undefined) return;
      const value = typeof option === 'string' ? option : option.label;
      this.submitAnswer(token, value, `Selected ${optionMarker(Number(choice))}: ${value}`);
    }
    await ctx.answerCbQuery();
  }
  private relayQuestion(session: TopicSession, listener: Listener, request: CollabUiRequest): void {
    if ([...this.questions.values()].some(question => question.listener === listener && question.request.reqId === request.reqId)) return;
    const token = randomBytes(12).toString('base64url');
    const question: PendingQuestion = {session, listener, request, messageIds:[],buttonIds:[]};
    this.questions.set(token, question);
    if (++listener.queued > 128) { this.dropListener(session.id); return; }
    listener.tail = listener.tail.then(async () => {
      const active = () => this.questions.get(token) === question && !this.stopped &&
        this.listeners.get(session.id) === listener && this.sessionAssigned(session) &&
        this.options.store.getSession(session.id)?.status === 'open';
      if (!active() || !(await this.ready(session.chatId))) { this.endQuestion(token); return; }
      const parts = [request.title];
      if (request.kind === 'select') {
        parts.push(...request.options.map((option, index) => {
          const label = typeof option === 'string' ? option : option.label;
          const marker = request.checkedIndices?.includes(index) ? '[x] ' : '';
          return `${optionMarker(index)} ${marker}${label}${typeof option !== 'string' && option.description ? `\n${option.description}` : ''}`;
        }));
        if (request.helpText) parts.push(request.helpText);
      } else if (request.prefill) parts.push(request.prefill);
      const body = parts.join('\n\n');
      for (let offset = 0; offset < body.length;) {
        if (!active()) return;
        let end = Math.min(offset+4000, body.length);
        if (end < body.length && body.charCodeAt(end-1) >= 0xD800 && body.charCodeAt(end-1) <= 0xDBFF) end--;
        const message = await this.delivery.run(session.chatId,
          () => this.bot.telegram.sendMessage(session.chatId,body.slice(offset,end),{message_thread_id:session.threadId}),active);
        if (!message) return;
        question.messageIds.push(message.message_id);
        offset = end;
      }
      const buttons = request.kind === 'select' ? request.options.map((_, index) =>
        ({text:optionMarker(index),callback_data:`ask:${token}:${index}`})) : [];
      for (let offset = 0; offset < Math.max(1,buttons.length); offset += 80) {
        if (!active()) return;
        const keyboard: {text:string;callback_data:string}[][] = [];
        for (let index = offset; index < Math.min(offset+80,buttons.length); index += 5) {
          keyboard.push(buttons.slice(index,Math.min(index+5,offset+80)));
        }
        if (offset+80 >= buttons.length) keyboard.push([{text:'Cancel',callback_data:`ask:${token}:cancel`}]);
        const message = await this.delivery.run(session.chatId,
          () => this.bot.telegram.sendMessage(session.chatId,
            request.kind === 'editor' ? 'You can type a custom answer below, or cancel here.' : 'Choose an answer by number:', {
              message_thread_id:session.threadId,
              reply_markup:{inline_keyboard:keyboard},
            }), active);
        if (!message) return;
        question.messageIds.push(message.message_id);
        question.buttonIds.push(message.message_id);
        if (!active()) {
          void this.delivery.run(session.chatId,
            () => this.bot.telegram.editMessageReplyMarkup(session.chatId,message.message_id,undefined,{inline_keyboard:[]}),
            () => !this.stopped && this.sessionAssigned(session)).catch(() => undefined);
        }
      }
      if (request.kind === 'editor' && active()) {
        const message = await this.delivery.run(session.chatId,
          () => this.bot.telegram.sendMessage(session.chatId,'Reply here with your answer. Multiline text is supported.',{
            message_thread_id:session.threadId,
            reply_markup:{force_reply:true,input_field_placeholder:'Type your custom answer'},
          }), active);
        if (!message) return;
        question.messageIds.push(message.message_id);
      }
    }).catch(error => {
      this.endQuestion(token);
      console.warn(`Could not relay agent question (${session.id}).`, error);
    }).finally(() => { listener.queued--; });
  }
  private onFrame(session: TopicSession, listener: Listener, frame: HostFrame, replay = false): void {
    if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) return;
    this.options.runtime.observeFrame(session.id,frame);
    if (frame.t === 'ui-request') {
      this.relayQuestion(session, listener, frame.request);
      return;
    }
    if (frame.t === 'ui-request-end') {
      const messageId = listener.pendingAnswers.get(frame.reqId);
      if (messageId !== undefined) {
        listener.pendingAnswers.delete(frame.reqId);
        this.acknowledgeMessage(session,messageId,listener);
      }
      for (const [token, question] of this.questions) {
        if (question.listener === listener && question.request.reqId === frame.reqId) this.endQuestion(token);
      }
      return;
    }
    if (frame.t === 'event' && frame.event.type === 'notice' && frame.event.level === 'info' &&
        frame.event.source === 'collab' && frame.event.message === `Telegram @${this.bot.botInfo!.username} interrupted`) {
      listener.pendingAnswers.clear();
      const messageId = listener.pendingStops.shift();
      if (messageId !== undefined) this.acknowledgeMessage(session,messageId,listener);
    }
    const interruptedBy = frame.t === 'event' ? miniAppInterruptionAuthor(frame.event) : undefined;
    if (interruptedBy) {
      listener.pendingAnswers.clear();
      listener.queuedMessages = 0;
      listener.activity = 'completed';
      void this.setTopicStatus(session, listener.activity);
      void this.bot.telegram.sendMessage(session.chatId, `⛔️${interruptedBy} interrupted the chat`, {
        message_thread_id: session.threadId,
      }).catch(() => undefined);
    }
    if (frame.t === 'welcome' || frame.t === 'state') {
      listener.queuedMessages = frame.state.queuedMessageCount;
      listener.activity = frame.state.isStreaming || listener.queuedMessages > 0 ? 'running' : 'completed';
      void this.setTopicStatus(session, listener.activity);
    } else if (frame.t === 'event' && frame.event.type === 'agent_start') {
      listener.activity = 'running';
      void this.setTopicStatus(session, listener.activity);
    } else if (frame.t === 'event' && frame.event.type === 'agent_end') {
      listener.activity = listener.queuedMessages > 0 ? 'running' : 'completed';
      void this.setTopicStatus(session, listener.activity);
    }
    if (frame.t === 'error') listener.pendingPrompts.shift();
    if (isStartupRejection(frame) && listener.initial) {
      const initial = listener.initial;
      initial.phase = 'retrying';
      clearTimeout(initial.timer);
      const delay = Math.min(1000,250 * ++initial.retries);
      if (Date.now()+delay >= initial.deadline) {
        listener.initial = undefined;
        void this.bot.telegram.sendMessage(session.chatId,`The host is still starting. The initial task was not admitted; send your task again after startup. ${this.promptHelp(session.chatId)}`,{message_thread_id:session.threadId}).catch(() => undefined);
      } else {
        initial.timer = setTimeout(() => {
          void this.authorize(session.chatId,initial.userId).then(() => {
            if (listener.initial !== initial || this.stopped || !this.sessionAssigned(session) || !listener.connection) return;
            if (Date.now() >= initial.deadline) {
              listener.initial = undefined;
              return;
            }
            initial.timer = setTimeout(() => { listener.initial = undefined; },initial.deadline-Date.now());
            initial.timer.unref();
            initial.phase = 'sent';
            this.sendPrompt(listener,initial.text,initial.messageId);
          }).catch(() => {
            clearTimeout(initial.timer);
            if (listener.initial === initial) listener.initial = undefined;
          });
        },delay);
        initial.timer.unref();
      }
      return;
    }
    if (frame.t === 'entry' && frame.entry.type === 'custom_message' &&
        frame.entry.customType === COLLAB_PROMPT_MESSAGE_TYPE && !replay) {
      const details = frame.entry.details;
      if (details && typeof details === 'object' && 'from' in details &&
          typeof details.from === 'string' && details.from !== `Telegram @${this.bot.botInfo!.username}`) {
        this.options.store.setReplyTarget(session.id,undefined);
      }
    }
    if (frame.t === 'entry' && frame.entry.type === 'custom_message' &&
        frame.entry.customType === COLLAB_PROMPT_MESSAGE_TYPE && !replay) {
      const entry = frame.entry;
      const content = typeof entry.content === 'string' ? entry.content
        : entry.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const details = entry.details;
      if (details && typeof details === 'object' &&
          'from' in details && details.from === `Telegram @${this.bot.botInfo!.username}`) {
        const index = listener.pendingPrompts.findIndex(pending => pending.text === content);
        if (index !== -1) {
          const [pending] = listener.pendingPrompts.splice(index,1);
          if (pending!.messageId !== undefined) {
            this.acknowledgeMessage(session,pending!.messageId,listener);
          }
        }
        if (listener.initial?.phase === 'sent' && content === listener.initial.text) {
          clearTimeout(listener.initial.timer);
          listener.initial = undefined;
        }
      }
    }
    if (frame.t === 'error') {
      listener.pendingAnswers.clear();
      listener.pendingStops.length = 0;
      const text = isStartupRejection(frame)
        ? 'The host is still starting. Your instruction was not accepted. Resend it after startup.'
        : 'OMP rejected an instruction. Open Session for details before resending.';
      void this.bot.telegram.sendMessage(session.chatId, text, { message_thread_id: session.threadId }).catch(() => undefined);
      return;
    }
    if (frame.t === 'snapshot-chunk') {
      for (const entry of frame.entries) {
        if (listener.recovering) this.onFrame(session, listener, { t: 'entry', entry }, true);
        else if (entry.type === 'message') {
          const result = assistantText(entry.message);
          if (result) this.options.store.rememberReply(session.id, result.fingerprint);
        }
      }
      if (frame.final) this.options.store.markSnapshot(session.id);
      return;
    }
    const result = frame.t === 'event' && frame.event.type === 'message_end' ? assistantText(frame.event.message) : frame.t === 'entry' && frame.entry.type === 'message' ? assistantText(frame.entry.message) : undefined;
    if (!result || !this.options.store.rememberReply(session.id,result.fingerprint)) return;
    const replyTarget = this.options.store.getReplyTarget(session.id);
    if (++listener.queued > 128) { this.dropListener(session.id); return; }
    listener.tail = listener.tail.then(async () => {
      if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) return;
      const current = this.options.store.getSession(session.id);
      if (!current || current.status !== 'open' || !(await this.ready(session.chatId)) || !this.sessionAssigned(current)) return;
      for (const text of renderTelegramMarkdown(result.text)) {
        if (!this.sessionAssigned(current)) return;
        await this.delivery.run(session.chatId,
          () => this.bot.telegram.sendMessage(session.chatId,text,{
            parse_mode:'HTML',
            message_thread_id:session.threadId,
            ...(replyTarget === undefined ? {} : {reply_parameters:{message_id:replyTarget,allow_sending_without_reply:true}}),
          }), () => !this.stopped && this.sessionAssigned(current) && this.listeners.get(session.id) === listener);
      }
    }).catch(() => undefined).finally(() => { listener.queued--; });
  }
}
export function createBot(options: BotOptions): BotService { return new BotService(options); }
