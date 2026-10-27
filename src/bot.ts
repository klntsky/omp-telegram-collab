import { createHash } from 'node:crypto';
import { Telegraf, TelegramError, type Context } from 'telegraf';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { COLLAB_PROMPT_MESSAGE_TYPE, type HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, BotConfig, TopicSession, HostBinding, CollabConnection } from '../shared/contracts.js';
import { Store } from './store.js';
import { isActiveMember, isAdministrator } from './auth.js';
import { connectCollab, isStartupRejection } from './collab.js';

export interface RuntimeLike {
  ensure(session: TopicSession): Promise<HostBinding>;
  attach(instanceId: string): Promise<HostBinding>;
  stop(id: string): Promise<void>;
  close(): Promise<void>;
}
export interface BotOptions { config: AppConfig; botConfig: BotConfig; token: string; store: Store; runtime: RuntimeLike; connect?: typeof connectCollab; bot?: Telegraf<Context> }
interface Listener {
  connection?: CollabConnection;
  promise?: Promise<CollabConnection>;
  tail: Promise<void>;
  queued: number;
  recovering: boolean;
  initial?: {
    text: string;
    userId: number;
    deadline: number;
    retries: number;
    phase: 'sent' | 'retrying';
    timer?: NodeJS.Timeout;
  };
}
const help = '/setup — enroll this forum (owner/admin)\n/new task — new topic and session\n/attach instanceId [name] — attach local host (owner/admin)\n/session — open this session\n/status — readiness\n/stop — abort work\nMention me or reply to my messages to instruct the agent.';
export function chunkText(text: string, size = 4000): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
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
  private updateTail: Promise<void> = Promise.resolve();
  private queuedUpdates = 0;
  private stopped = false;
  private polling?: { controller: TelegramAbortController; done: Promise<void> };
  constructor(private readonly options: BotOptions) {
    this.bot = options.bot ?? new Telegraf(options.token);
    this.config = options.botConfig;
    this.token = options.token;
    this.bot.use(async ctx => {
      if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => undefined);
      if (++this.queuedUpdates > 256) { this.queuedUpdates--; return; }
      const task = this.updateTail.then(() => this.handle(ctx));
      this.updateTail = task.catch(() => undefined);
      try { await task; } catch { if (ctx.chat) await ctx.reply('The operation could not be completed. Check the local service and try again.').catch(() => undefined); }
      finally { this.queuedUpdates--; }
    });
    this.bot.catch(() => undefined);
  }
  get id(): number { return this.bot.botInfo?.id ?? 0; }
  async initialize(): Promise<void> {
    this.bot.botInfo ??= await this.bot.telegram.getMe();
    for (const existing of this.options.store.listSessions(this.id)) {
      if (existing.status === 'open' && this.options.store.isEnrolled(this.id, existing.chatId)) {
        void this.listen(existing).then(() => this.sendInitial(existing)).catch(() => this.scheduleReconnect(existing));
      }
    }
  }
  async start(): Promise<void> {
    await this.initialize();
    if (this.stopped) return;
    if (!this.polling) {
      const controller = new TelegramAbortController();
      this.polling = { controller, done: this.poll(controller) };
    }
    await this.polling.done;
  }
  private async poll(controller: TelegramAbortController): Promise<void> {
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
            offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
          }, { signal: controller.signal });
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
    this.polling?.controller.abort();
    await this.polling?.done.catch(() => undefined);
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    this.reconnects.clear();
    for (const item of this.listeners.values()) {
      clearTimeout(item.initial?.timer);
      item.connection?.close();
    }
    this.listeners.clear();
    await this.updateTail;
  }
  async authorize(chatId: number, userId: number): Promise<void> {
    if (!this.options.store.isEnrolled(this.id, chatId)) throw new Error('Group not enrolled');
    const [chat, user, bot] = await Promise.all([this.bot.telegram.getChat(chatId), this.bot.telegram.getChatMember(chatId, userId), this.bot.telegram.getChatMember(chatId, this.id)]);
    if (chat.type !== 'supergroup' || !chat.is_forum || !isActiveMember(user) || bot.status !== 'administrator' || !bot.can_manage_topics) throw new Error('Group access denied');
  }
  private async ready(chatId: number): Promise<boolean> {
    const [chat, member] = await Promise.all([this.bot.telegram.getChat(chatId), this.bot.telegram.getChatMember(chatId, this.id)]);
    return chat.type === 'supergroup' && chat.is_forum === true && member.status === 'administrator' && member.can_manage_topics === true;
  }
  private isOwner(user: Context['from']): boolean {
    return Boolean(user && !user.is_bot && user.username && this.config.ownerUsernames.includes(user.username.toLowerCase()));
  }
  private async ownerAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.from || ctx.from.is_bot || !ctx.chat) return false;
    const member = await this.bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return this.isOwner(member.user) && isAdministrator(member);
  }
  private link(session: TopicSession): string {
    return `https://t.me/${this.bot.botInfo!.username}/${this.config.miniAppShortName}?startapp=s_${session.id}`;
  }
  private async announce(session: TopicSession): Promise<void> {
    await this.bot.telegram.sendMessage(session.chatId, 'Session ready. Mention me or reply to my messages to start coding.', { message_thread_id: session.threadId, reply_markup: { inline_keyboard: [[{ text: 'Open Session', url: this.link(session) }]] } });
  }
  private async newSession(ctx: Context, task: string, attached?: { instanceId: string; sessionId: string }, name?: string): Promise<void> {
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const title = (name ?? task).replace(/\s+/g, ' ').trim().slice(0, 128) || 'OMP session';
    const topic = await this.bot.telegram.createForumTopic(ctx.chat!.id, title);
    const session = this.options.store.createSession({ botId: this.id, chatId: ctx.chat!.id, threadId: topic.message_thread_id }, title, attached ? { kind:'attached', ...attached } : {kind:'managed'}, attached ? undefined : task, ctx.from!.id);
    await this.listen(session);
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    await this.announce(session);
    await this.sendInitial(session);
  }
  private async askTask(ctx: Context): Promise<void> {
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const name = ctx.from!.first_name;
    const message = await ctx.reply(`${name}, what should we work on? Reply to this message with the initial task.`, {
      entities: [{type:'text_mention',offset:0,length:name.length,user:ctx.from!}],
      reply_markup: {force_reply:true,selective:true,input_field_placeholder:'Describe the coding task'},
    });
    this.options.store.addTaskRequest(this.id, ctx.chat!.id, message.message_id, ctx.from!.id, ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id ?? 1 : 1);
  }
  private async setup(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.from || !(await this.ownerAdmin(ctx))) { await ctx.reply('Only a configured owner who is a current group administrator can enroll this group.'); return; }
    if (!(await this.ready(ctx.chat.id))) {
      await ctx.reply('Use a supergroup with Topics enabled, then grant this bot Manage Topics permission.', { reply_markup: { inline_keyboard: [[{text:'Check Again',callback_data:'setup:check'}]] } }); return;
    }
    this.options.store.enrollGroup(this.id, ctx.chat.id);
    await ctx.reply('Ready. Every new topic becomes an OMP session. Current group members can control the local coding agent.', { reply_markup: { inline_keyboard: [[{text:'New Session',callback_data:'session:new'}],[{text:'Check Again',callback_data:'setup:check'}]] } });
  }
  private async handle(ctx: Context): Promise<void> {
    if (this.stopped) return;
    if (ctx.callbackQuery) {
      if (!('data' in ctx.callbackQuery) || !ctx.chat || !ctx.from || ctx.from.is_bot) return;
      if (ctx.callbackQuery.data === 'setup:check') await this.setup(ctx);
      if (ctx.callbackQuery.data === 'session:new') await this.askTask(ctx);
      return;
    }
    if (ctx.myChatMember) {
      if (ctx.chat && this.isOwner(ctx.myChatMember.from) && ['administrator','member'].includes(ctx.myChatMember.new_chat_member.status)) await ctx.reply('A configured owner who is a group administrator can run /setup to enroll this forum.');
      return;
    }
    const message = ctx.message;
    if (!message || !ctx.chat) return;
    const topicLifecycle = 'forum_topic_created' in message || 'forum_topic_edited' in message || 'forum_topic_closed' in message || 'forum_topic_reopened' in message;
    if ('forward_origin' in message || 'forward_date' in message || (ctx.from?.is_bot && !topicLifecycle)) return;
    const text = 'text' in message ? message.text : undefined;
    const command = text?.match(/^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (command?.[2] && command[2].toLowerCase() !== this.bot.botInfo!.username.toLowerCase()) return;
    if (ctx.chat.type === 'private') {
      if (!this.isOwner(ctx.from)) { await ctx.reply('This bot is managed by its configured owner.'); return; }
      await ctx.reply('Add me to your own supergroup, enable Topics, grant Manage Topics, then run /setup. Configure the Mini App URL in BotFather for this bot.', {reply_markup:{inline_keyboard:[[{text:'Add to Group',url:`https://t.me/${this.bot.botInfo!.username}?startgroup=setup&admin=manage_topics`}]]}}); return;
    }
    if (command?.[1]?.toLowerCase() === 'setup') { await this.setup(ctx); return; }
    if (!this.options.store.isEnrolled(this.id, ctx.chat.id)) {
      if (command?.[1]?.toLowerCase() === 'status') {
        await ctx.reply(`${await this.ready(ctx.chat.id) ? 'Forum permissions ready.' : 'Enable Topics in a supergroup and grant Manage Topics.'} A configured owner/admin must run /setup to enroll this group.`);
      } else if (command?.[1]?.toLowerCase() === 'help') {
        await ctx.reply(help);
      }
      return;
    }
    const threadId = 'message_thread_id' in message ? message.message_thread_id ?? 1 : 1;
    const key = {botId:this.id,chatId:ctx.chat.id,threadId};
    let session = this.options.store.getTopic(key);
    if ('forum_topic_created' in message && threadId !== 1) {
      if (!session) {
        session = this.options.store.createSession(key, message.forum_topic_created.name);
        await this.listen(session); await this.announce(session);
      }
      return;
    }
    if (session && 'forum_topic_edited' in message) {
      if (message.forum_topic_edited.name) this.options.store.updateSession(session.id, {name:message.forum_topic_edited.name}); return;
    }
    if (session && 'forum_topic_closed' in message) {
      this.options.store.updateSession(session.id, {status:'closed'}); this.dropListener(session.id); await this.options.runtime.stop(session.id); return;
    }
    if (session && 'forum_topic_reopened' in message) { session = this.options.store.updateSession(session.id,{status:'open'})!; await this.listen(session); return; }
    if (!ctx.from || ctx.from.is_bot || !text || 'forward_origin' in message || 'forward_date' in message) return;
    await this.authorize(ctx.chat.id, ctx.from.id);
    if (command) {
      const action = command[1]!.toLowerCase(), arg = command[3]?.trim() ?? '';
      if (action === 'new') { if (arg) await this.newSession(ctx,arg); else await this.askTask(ctx); return; }
      if (action === 'attach') {
        if (!(await this.ownerAdmin(ctx))) { await ctx.reply('Attaching requires a configured owner who is a group administrator.'); return; }
        const match = arg.match(/^([A-Za-z0-9_-]+)(?:\s+(.+))?$/);
        if (!match) { await ctx.reply('Usage: /attach instanceId [topic name]. Get the instance ID from omp collab list.'); return; }
        const binding = await this.options.runtime.attach(match[1]!);
        await this.newSession(ctx,'',{instanceId:binding.instanceId,sessionId:binding.sessionId},match[2] ?? 'Attached OMP session'); return;
      }
      if (action === 'help' || action === 'start') { await ctx.reply(help); return; }
      if (action === 'status') { await ctx.reply(`${await this.ready(ctx.chat.id) ? 'Forum ready.' : 'Forum permissions need attention.'}${session ? `\nSession: ${session.name} (${session.status})` : '\nUse /new task to create a session.'}`); return; }
      if (action === 'session') {
        if (!session) { await ctx.reply('No session in this topic. Use /new task or create a topic.'); return; }
        await ctx.reply(`${session.name} (${session.status})`,{reply_markup:{inline_keyboard:[[{text:'Open Session',url:this.link(session)}]]}}); return;
      }
      if (action === 'stop' && session) {
        if (session.status !== 'open') { await ctx.reply('This session is archived. Reopen the topic before sending instructions.'); return; }
        const connection = await this.listen(session);
        await this.authorize(ctx.chat.id, ctx.from.id);
        const listener = this.listeners.get(session.id);
        clearTimeout(listener?.initial?.timer);
        if (listener) listener.initial = undefined;
        connection.send({t:'abort'});
        await ctx.reply('Abort requested.');
        return;
      }
      return;
    }
    if ('reply_to_message' in message && message.reply_to_message && this.options.store.takeTaskRequest(this.id,ctx.chat.id,message.reply_to_message.message_id,ctx.from.id)) { await this.newSession(ctx,text); return; }
    if (!session) return;
    const entities = 'entities' in message ? message.entities ?? [] : [];
    const mentions = entities.filter(entity =>
      (entity.type === 'mention' && text.slice(entity.offset,entity.offset+entity.length).toLowerCase() === `@${this.bot.botInfo!.username.toLowerCase()}`) ||
      (entity.type === 'text_mention' && entity.user.id === this.id),
    );
    const replyToBot = 'reply_to_message' in message && message.reply_to_message?.from?.id === this.id;
    if (!mentions.length && !replyToBot) return;
    if (session.status !== 'open') { await ctx.reply('This session is archived. Reopen the topic before sending instructions.'); return; }
    let prompt = text;
    for (const entity of [...mentions].reverse()) prompt = prompt.slice(0,entity.offset) + prompt.slice(entity.offset+entity.length);
    prompt = prompt.trim();
    if (prompt) {
      const connection = await this.listen(session);
      await this.authorize(ctx.chat.id, ctx.from.id);
      if (this.listeners.get(session.id)?.initial) {
        await ctx.reply('The initial task is still being admitted. Wait for the host to start before sending another instruction.');
        return;
      }
      connection.send({t:'prompt',text:prompt});
    }
  }
  private scheduleReconnect(session: TopicSession, attempt = 0): void {
    if (this.stopped) return;
    const current = this.options.store.getSession(session.id);
    if (current?.status !== 'open' || this.reconnects.has(session.id)) return;
    if (attempt >= 5) {
      void this.bot.telegram.sendMessage(session.chatId, 'Session mirroring disconnected. Mention me to reconnect to the local host.', { message_thread_id: session.threadId }).catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      this.reconnects.delete(session.id);
      if (this.stopped) return;
      const active = this.options.store.getSession(session.id);
      if (active?.status !== 'open') return;
      void this.listen(active).then(() => this.sendInitial(active)).catch(() => this.scheduleReconnect(active, attempt + 1));
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
    listener?.connection?.close();
  }
  private listen(session: TopicSession): Promise<CollabConnection> {
    const existing = this.listeners.get(session.id);
    if (existing?.promise) return existing.promise;
    const listener: Listener = {tail:Promise.resolve(),queued:0,recovering:this.options.store.hasSnapshot(session.id)};
    this.listeners.set(session.id, listener);
    listener.promise = this.options.runtime.ensure(session).then(binding => (this.options.connect ?? connectCollab)(binding,`Telegram @${this.bot.botInfo!.username}`,{
      onFrame: frame => this.onFrame(session,listener,frame),
      onClose: () => {
        if (this.listeners.get(session.id) !== listener) return;
        const connected = listener.connection !== undefined;
        this.dropListener(session.id);
        if (connected) this.scheduleReconnect(session);
      },
    })).then(connection => {
      if (this.stopped || this.listeners.get(session.id) !== listener) { connection.close(); throw new Error('Session closed'); }
      listener.connection = connection; return connection;
    }).catch(error => { if (this.listeners.get(session.id) === listener) this.listeners.delete(session.id); throw error; });
    return listener.promise;
  }
  private async sendInitial(session: TopicSession): Promise<void> {
    const connection = await this.listen(session);
    const userId = this.options.store.getInitialUser(session.id);
    if (!userId) return;
    await this.authorize(session.chatId,userId);
    const task = this.options.store.claimInitialTask(session.id);
    if (!task) return;
    const listener = this.listeners.get(session.id)!;
    listener.initial = {text:task,userId,deadline:Date.now()+this.options.config.omp.startupTimeoutMs,retries:0,phase:'sent'};
    listener.initial.timer = setTimeout(() => { listener.initial = undefined; },this.options.config.omp.startupTimeoutMs);
    listener.initial.timer.unref();
    connection.send({t:'prompt',text:task});
  }
  private onFrame(session: TopicSession, listener: Listener, frame: HostFrame): void {
    if (this.stopped || this.listeners.get(session.id) !== listener) return;
    if (isStartupRejection(frame) && listener.initial) {
      const initial = listener.initial;
      initial.phase = 'retrying';
      clearTimeout(initial.timer);
      const delay = Math.min(1000,250 * ++initial.retries);
      if (Date.now()+delay >= initial.deadline) {
        listener.initial = undefined;
        void this.bot.telegram.sendMessage(session.chatId,'The host is still starting. The initial task was not admitted; mention me with your task after startup.',{message_thread_id:session.threadId}).catch(() => undefined);
      } else {
        initial.timer = setTimeout(() => {
          void this.authorize(session.chatId,initial.userId).then(() => {
            if (listener.initial !== initial || this.stopped || !listener.connection) return;
            if (Date.now() >= initial.deadline) {
              listener.initial = undefined;
              return;
            }
            initial.timer = setTimeout(() => { listener.initial = undefined; },initial.deadline-Date.now());
            initial.timer.unref();
            initial.phase = 'sent';
            listener.connection.send({t:'prompt',text:initial.text});
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
        frame.entry.customType === COLLAB_PROMPT_MESSAGE_TYPE && listener.initial?.phase === 'sent') {
      const entry = frame.entry;
      const content = typeof entry.content === 'string' ? entry.content
        : entry.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const details = entry.details;
      if (content === listener.initial.text && details && typeof details === 'object' &&
          'from' in details && details.from === `Telegram @${this.bot.botInfo!.username}`) {
        clearTimeout(listener.initial.timer);
        listener.initial = undefined;
      }
    }
    if (frame.t === 'error') {
      const text = isStartupRejection(frame)
        ? 'The host is still starting. Your instruction was not accepted. Resend it after startup.'
        : 'OMP rejected an instruction. Open Session for details before resending.';
      void this.bot.telegram.sendMessage(session.chatId, text, { message_thread_id: session.threadId }).catch(() => undefined);
      return;
    }
    if (frame.t === 'snapshot-chunk') {
      for (const entry of frame.entries) {
        if (listener.recovering) this.onFrame(session, listener, { t: 'entry', entry });
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
    if (++listener.queued > 128) { this.dropListener(session.id); return; }
    listener.tail = listener.tail.then(async () => {
      if (this.stopped) return;
      const current = this.options.store.getSession(session.id);
      if (!current || current.status !== 'open' || !this.options.store.isEnrolled(this.id,session.chatId) || !(await this.ready(session.chatId))) return;
      for (const text of chunkText(result.text)) await this.bot.telegram.sendMessage(session.chatId,text,{message_thread_id:session.threadId});
    }).catch(() => undefined).finally(() => { listener.queued--; });
  }
}
export function createBot(options: BotOptions): BotService { return new BotService(options); }
