import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { Bot, GrammyError, HttpError, type Context } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { AbortSignal as TelegramAbortSignal } from 'abort-controller';
import { COLLAB_PROMPT_MESSAGE_TYPE, type ImageContent, type CollabUiRequest, type HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, BotConfig, TopicSession, HostBinding, CollabConnection } from '../shared/contracts.js';
import { Store, type PendingSkillKey } from './store.js';
import { isActiveMember, isAdministrator } from './auth.js';
import { connectCollab, isStartupRejection } from './collab.js';
import { renderTelegramMarkdown } from './telegram-markdown.js';
import { SessionCapacityError, SessionTitleUnsupportedError } from './runtime.js';
import { configWritable, findInstance, readConfig, writeConfig, refreshTermination } from './config.js';
import { miniAppInterruptionAuthor } from '../shared/interruption.js';
import { TelegramDelivery } from './telegram-delivery.js';
import { SkillPicker, type SkillCatalogEntry } from './skill-picker.js';
import { topicDestination, sameTopicDestination, type TopicDestination } from '../shared/topic-destination.js';
import { contextDestination, replyTo, sendTo, forwardTo } from './telegram-destination.js';
import { isMentionableSkillName, skillCommandAliases } from './skill-commands.js';
import { withCancellation } from './cancellation.js';

class AuthorizationDeniedError extends Error {}

export interface RuntimeLike {
  worktree(session: TopicSession, branch?: string): Promise<string>;
  topicTitleStatus(session: TopicSession): Promise<{worktree: boolean; branch?: string}>;
  ensure(session: TopicSession): Promise<HostBinding>;
  isRunning(session: TopicSession): Promise<boolean>;
  setSessionTitle(session: TopicSession, title: string): Promise<void>;
  attach(instanceId: string, instancePath: string): Promise<HostBinding>;
  stop(id: string): Promise<void>;
  kill(session: TopicSession): Promise<void>;
  modelPresets(session: TopicSession, name?: string): Promise<string>;
  availableModelPresets(instancePath: string): Promise<string[]>;
  listSkills(instancePath: string, session?: TopicSession, signal?: AbortSignal): Promise<{name: string; description: string}[]>;
  getSessionLimit(): number;
  increaseSessionLimit(expectedLimit: number): boolean;
  observeFrame(sessionId: string, frame: HostFrame): void;
  markPrompt(sessionId: string): void;
  retain(sessionId: string): () => void;
  close(): Promise<void>;
}
export interface BotOptions { config: AppConfig; botConfig: BotConfig; token: string; store: Store; runtime: RuntimeLike; connect?: typeof connectCollab; bot?: Bot<Context>; configWritable?: () => boolean; telegramIntervalMs?: number }
type TopicActivity = 'running' | 'finished';
interface StatusFailure { operation: string; at: number; error: unknown }
interface TaskObservation { state: 'waiting for acceptance' | 'not accepted' | 'acceptance unknown' | 'accepted; completion unknown' }
interface SessionObservation { task?: TaskObservation; failure?: StatusFailure; mirrored?: boolean }
interface Listener {
  sessionId: string;
  connection?: CollabConnection;
  promise?: Promise<CollabConnection>;
  tail: Promise<void>;
  titleTail?: Promise<void>;
  titleVersion?: number;
  sessionTitle?: string;
  queued: number;
  recovering: boolean;
  pendingPrompts: { text: string; messageId?: number; onStartupRejected?: () => void; observation: TaskObservation }[];
  pendingAnswers: Map<number, number>;
  pendingStops: number[];
  queuedMessages: number;
  activity: TopicActivity;
  initial?: {
    text: string;
    images?: ImageContent[];
    userId: number;
    authorityUserId: number;
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
  images?: ImageContent[];
  instancePath: string;
  sessionId?: string;
  worktree?: boolean;
  generation?: number;
  allMessagesArePrompts: boolean;
  messageId: number;
  expires: number;
}
type SettingsPage = 'root' | 'prompts' | 'proposals' | 'skills' | 'presets' | 'capacity';
type SettingsAction = { kind: 'page'; page: SettingsPage; offset?: number }
  | { kind: 'set'; field: 'all_messages_are_prompts' | 'users_can_propose_prompts'; value: boolean }
  | { kind: 'default'; field: 'default_new_topic_skill' | 'default_model_preset'; value?: string }
  | { kind: 'capacity'; limit: number; confirm: boolean }
  | { kind: 'close' };
interface SettingsPanel {
  token: string;
  chatId: number;
  destination: TopicDestination;
  messageId: number;
  instancePath: string;
  expires: number;
  revision: number;
  choices: SettingsAction[];
}
const help = '/setup — request or enroll this forum, then open settings\n/settings — forum defaults and shared capacity (group admin)\n/new task — new topic and session\n/worktree [branch] — move this session into an OMP worktree; General creates a topic first\n/attach instanceId [name] — attach local host (group admin)\n/detach — make this topic conversation-only (group admin)\n/model_preset <name> — switch this session (group admin)\n/list_model_presets — list presets for this session (group admin)\n/session — open this session\n/status — host, mirroring, task admission, recovery and skill diagnostics\n/stop — interrupt the current turn (session topic only)\n/kill — force-kill the host process (session topic only)\n/terminate — terminate all agents and suspend the service (group admin)';
const settingsHelp = '/settings — forum defaults and shared capacity (group admin)';
const adminHelp = '/list_admins — list current human group owner and administrators. Manage administrator roles in Telegram.';
const terminationMessage = 'The service got terminated, only admin can resume it (remove terminated: true from the config)';
const groupCommands = [
  { command: 'new', description: 'Start a new session' },
  { command: 'worktree', description: 'Move session to an OMP worktree; new topic in General' },
  { command: 'p', description: 'New session in General; prompt in explicit-command topics' },
  { command: 'skills', description: 'Select or clear skills for your next prompt' },
  { command: 'settings', description: 'Forum defaults and shared capacity (group admin)' },
  { command: 'setup', description: 'Request or enroll this forum, then open settings' },
  { command: 'list_admins', description: 'List current human group owner and administrators' },
  { command: 'attach', description: 'Attach a local OMP host (group admin)' },
  { command: 'detach', description: 'Make this topic conversation-only (group admin)' },
  { command: 'session', description: 'Open this topic’s session' },
  { command: 'status', description: 'Show host, mirroring, recovery and skill diagnostics' },
  { command: 'stop', description: 'Interrupt the current turn in this session topic' },
  { command: 'kill', description: 'Force-kill this session’s host; preserve history' },
  { command: 'terminate', description: 'Terminate all agents and suspend service (group admin)' },
  { command: 'model_preset', description: 'Switch session model preset (group admin)' },
  { command: 'list_model_presets', description: 'List session model presets (group admin)' },
  { command: 'help', description: 'Show commands and prompt settings' },
  { command: 'start', description: 'Show bot setup and command guidance' },
];
function messageText(message: Context['message']): string | undefined {
  if (!message) return undefined;
  if ('text' in message) return message.text;
  if ('caption' in message && message.caption !== undefined) return message.caption;
  if (message.photo || message.document?.mime_type?.startsWith('image/')) return 'Describe this image.';
  return undefined;
}
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
  readonly bot: Bot<Context>;
  readonly config: BotConfig;
  readonly token: string;
  private readonly listeners = new Map<string, Listener>();
  private readonly titleRevisions = new Map<string,number>();
  private readonly humanTitles = new Map<string,string>();
  private readonly titlePrefixes = new Map<string,Set<string>>();
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  private readonly capacityRequests = new Map<string, CapacityRequest>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly endedQuestionReplies = new Set<string>();
  private readonly delivery: TelegramDelivery;
  private readonly topicIcons = new Map<string, { status?: TopicActivity; revision: number; tail: Promise<void> }>();
  private readonly sessionKillHandlers = new Set<(sessionId: string) => void>();
  private readonly commandMenus = new Map<number, string>();
  private readonly skillAliases = new Map<number, Map<string, SkillCatalogEntry>>();
  private menuTimer?: NodeJS.Timeout;
  private readonly background = new AbortController();
  private catalogRefresh = new AbortController();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly catalogTasks = new Map<string, Promise<void>>();
  private readonly apiAbort = new TelegramAbortController();
  private backgroundStarted = false;
  private readonly restoring = new Set<string>();
  private readonly sessionObservations = new Map<string, SessionObservation>();
  private readonly catalogObservations = new Map<string, {refreshedAt?:number;failure?:StatusFailure;failed?:boolean}>();
  private readonly reconnecting = new Set<string>();
  private menuTail: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
  private termination?: Promise<void>;
  private readonly promptProposals = new Map<string, PromptProposal>();
  private readonly receivedMessages = new WeakSet<Context>();
  private readonly directedReplies = new WeakSet<Context>();
  private readonly albums = new Map<string, {contexts:Context[];ready:Promise<void>;resolve:()=>void;timer?:NodeJS.Timeout}>();
  private readonly albumPrompts = new WeakMap<Context, {contexts:Context[];text:string}>();
  private readonly settingsPanels = new Map<string, SettingsPanel>();
  private readonly settingsMessages = new Set<string>();
  private async settingsAccess(ctx: Context, panel: SettingsPanel, writable = false): Promise<AppConfig> {
    await this.authorize(panel.chatId, ctx.from!.id);
    if (writable && !(this.options.configWritable?.() ?? configWritable(this.options.config.configPath))) {
      throw new Error('Configuration is read-only. Ask the local operator to change its source or permissions. No settings were saved.');
    }
    const member = await this.bot.api.getChatMember(panel.chatId, ctx.from!.id);
    const persisted = readConfig(this.options.config.configPath);
    if (this.assignedPath(panel.chatId) !== panel.instancePath ||
        findInstance(persisted, this.id, panel.chatId)?.path !== panel.instancePath ||
        !isAdministrator(member)) {
      throw new Error('The configured instance assignment or administrator access changed. No settings were saved.');
    }
    return persisted;
  }
  private async openSettings(ctx: Context): Promise<void> {
    if (!(await this.currentAdmin(ctx))) {
      await replyTo(ctx, contextDestination(ctx), 'Settings require a current group owner or administrator.');
      return;
    }
    const panel: SettingsPanel = {
      token: randomBytes(16).toString('base64url'), chatId: ctx.chat!.id,
      destination: contextDestination(ctx), messageId: 0, instancePath: this.assignedPath(ctx.chat!.id),
      expires: Date.now() + 15 * 60_000, revision: 0, choices: [],
    };
    const persisted = await this.settingsAccess(ctx, panel);
    for (const [token, old] of this.settingsPanels) if (old.expires <= Date.now()) this.settingsPanels.delete(token);
    if (this.settingsPanels.size >= 256) this.settingsPanels.delete(this.settingsPanels.keys().next().value!);
    const message = await replyTo(ctx, panel.destination, 'Opening settings…');
    panel.messageId = message.message_id;
    this.settingsMessages.add(`${panel.chatId}:${panel.messageId}`);
    if (this.settingsMessages.size > 4096) this.settingsMessages.delete(this.settingsMessages.values().next().value!);
    this.settingsPanels.set(panel.token, panel);
    await this.renderSettings(panel, persisted);
  }
  private async renderSettings(panel: SettingsPanel, config: AppConfig, page: SettingsPage = 'root', offset = 0): Promise<void> {
    const assigned = findInstance(config, this.id, panel.chatId)!;
    const chat = assigned.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)!;
    const rows: {text: string; callback_data: string}[][] = [];
    const choices: SettingsAction[] = [];
    const revision = panel.revision + 1;
    const button = (text: string, action: SettingsAction) => {
      const index = choices.push(action) - 1;
      rows.push([{text: text.slice(0, 100), callback_data: `settings:${panel.token}:${revision}:${index}`}]);
    };
    let text = 'Settings\nForum defaults apply to this forum, not the current topic. Existing topic skills and running models are unchanged.';
    if (page === 'root') {
      text += `\n\nPrompt mode: ${chat.all_messages_are_prompts === false ? 'Only /p' : 'All messages'}\nUser proposals: ${chat.users_can_propose_prompts === true ? 'Allowed' : 'Ignored'}\nDefault new-topic skill: ${chat.default_new_topic_skill ?? '(not set)'}\nDefault model preset: ${chat.default_model_preset ?? '(not set)'}\nShared capacity: ${config.omp.maxSessions} sessions across all instances`;
      for (const [label, target] of [['Prompt mode','prompts'],['User proposals','proposals'],['Default new-topic skill','skills'],['Default model preset','presets'],['Shared capacity','capacity']] as const) {
        button(label, {kind:'page',page:target});
      }
    } else if (page === 'prompts' || page === 'proposals') {
      const prompts = page === 'prompts';
      text = prompts ? `Forum prompt mode: ${chat.all_messages_are_prompts === false ? 'Only /p' : 'All messages'}` : `Forum user proposals: ${chat.users_can_propose_prompts === true ? 'Allowed' : 'Ignored'}`;
      button(prompts ? 'All messages' : 'Allow user proposals', {kind:'set',field:prompts ? 'all_messages_are_prompts' : 'users_can_propose_prompts',value:true});
      button(prompts ? 'Only /p' : 'Ignore non-admin prompts', {kind:'set',field:prompts ? 'all_messages_are_prompts' : 'users_can_propose_prompts',value:false});
    } else if (page === 'skills' || page === 'presets') {
      const skill = page === 'skills';
      const names = skill ? (await this.options.runtime.listSkills(panel.instancePath)).map(entry => entry.name).filter(isMentionableSkillName) : await this.options.runtime.availableModelPresets(panel.instancePath);
      if (this.assignedPath(panel.chatId) !== panel.instancePath) throw new Error('The group instance assignment changed');
      const field = skill ? 'default_new_topic_skill' : 'default_model_preset';
      text = `Forum ${skill ? 'new-topic skill' : 'model preset'} default: ${chat[field] ?? '(not set)'}\n${names.length ? `Choose a default (${offset + 1}–${Math.min(offset + 8, names.length)} of ${names.length}).` : 'No choices available.'}\n${skill ? 'Future topics use this skill. Existing topics are unchanged.' : 'Managed hosts apply this default when they next start. Running hosts are unchanged.'}`;
      for (const name of names.slice(offset, offset + 8)) button(name, {kind:'default',field,value:name});
      button('Clear default', {kind:'default',field});
      if (offset > 0) button('Previous', {kind:'page',page,offset:Math.max(0,offset-8)});
      if (offset + 8 < names.length) button('Next', {kind:'page',page,offset:offset+8});
    } else {
      const limit = this.options.runtime.getSessionLimit();
      text = `Shared capacity: ${limit} sessions.\nThis limit applies to all bots and instances in this service, not just this forum. Increasing it does not submit or retry any tasks.`;
      if (Number.isSafeInteger(limit * 2)) button(`Increase to ${limit * 2}`, {kind:'capacity',limit,confirm:false});
    }
    if (page !== 'root') button('Back', {kind:'page',page:'root'});
    button('Close', {kind:'close'});
    try {
      await this.bot.api.editMessageText(panel.chatId, panel.messageId, text.startsWith('Settings\n') ? text : `Settings\n${text}`, {reply_markup:{inline_keyboard:rows}});
      panel.choices = choices;
      panel.revision = revision;
    } catch (error) {
      this.settingsPanels.delete(panel.token);
      throw error;
    }
  }
  private async settingsCallback(ctx: Context, data: string): Promise<void> {
    const match = data.match(/^settings:([A-Za-z0-9_-]{22}):(\d+):(\d+)$/);
    const panel = match ? this.settingsPanels.get(match[1]!) : undefined;
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!match || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        !('from' in message) || message.from?.id !== this.id || 'forward_origin' in message || 'forward_date' in message) return;
    if (!panel) {
      await ctx.answerCallbackQuery('This settings button expired. Open /settings again.');
      return;
    }
    if (ctx.chat.id !== panel.chatId || message.message_id !== panel.messageId ||
        !sameTopicDestination(contextDestination(ctx), panel.destination)) return;
    if (panel.expires <= Date.now() || Number(match![2]) !== panel.revision) {
      await ctx.answerCallbackQuery('This settings button expired. Open /settings again.');
      return;
    }
    const action = panel.choices[Number(match![3])];
    if (!action) return;
    const config = await this.settingsAccess(ctx, panel, action.kind === 'set' || action.kind === 'default' || (action.kind === 'capacity' && action.confirm));
    if (action.kind === 'close') {
      this.settingsPanels.delete(panel.token);
      await this.bot.api.editMessageText(panel.chatId,panel.messageId,'Settings closed.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    if (action.kind === 'page') { await this.renderSettings(panel,config,action.page,action.offset); return; }
    if (action.kind === 'capacity') {
      if (this.options.runtime.getSessionLimit() !== action.limit || config.omp.maxSessions !== action.limit) throw new Error('The shared session limit changed. Open Shared capacity again.');
      if (!action.confirm) {
        panel.revision++;
        panel.choices = [{kind:'capacity',limit:action.limit,confirm:true},{kind:'page',page:'capacity'},{kind:'close'}];
        try {
          await this.bot.api.editMessageText(panel.chatId,panel.messageId,`Settings\nIncrease shared capacity from ${action.limit} to ${action.limit * 2} for every bot and instance?`,{reply_markup:{inline_keyboard:panel.choices.map((_,index) => [{text:['Confirm increase','Back','Close'][index]!,callback_data:`settings:${panel.token}:${panel.revision}:${index}`}])}});
        } catch (error) {
          this.settingsPanels.delete(panel.token);
          throw error;
        }
        return;
      }
      config.omp.maxSessions = action.limit * 2;
      writeConfig(config);
      this.options.config.omp.maxSessions = config.omp.maxSessions;
      if (!this.options.runtime.increaseSessionLimit(action.limit)) throw new Error('The shared runtime session limit changed before the increase could be applied.');
    } else {
      if (action.kind === 'default' && action.value !== undefined) {
        const names = action.field === 'default_new_topic_skill'
          ? (await this.options.runtime.listSkills(panel.instancePath)).map(entry => entry.name)
          : await this.options.runtime.availableModelPresets(panel.instancePath);
        if (!names.includes(action.value)) throw new Error(`Unknown ${action.field === 'default_new_topic_skill' ? 'skill' : 'model preset'}: ${action.value}`);
      }
      const current = await this.settingsAccess(ctx,panel,true);
      const chat = findInstance(current,this.id,panel.chatId)!.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)!;
      if (action.kind === 'set') chat[action.field] = action.value;
      else if (action.value === undefined) delete chat[action.field];
      else chat[action.field] = action.value;
      writeConfig(current);
      Object.assign(findInstance(this.options.config,this.id,panel.chatId)!.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)!,chat);
      if (action.kind === 'default' && action.value === undefined) delete findInstance(this.options.config,this.id,panel.chatId)!.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)![action.field];
      await this.syncCommandMenus();
      await this.renderSettings(panel,current);
      return;
    }
    await this.renderSettings(panel,config);
  }
  private async settingsReply(ctx: Context): Promise<boolean> {
    const message = ctx.message;
    const reply = message && 'reply_to_message' in message ? message.reply_to_message : undefined;
    if (!reply || !ctx.chat || !(this.settingsMessages.has(`${ctx.chat.id}:${reply.message_id}`) ||
        (reply.from?.id === this.id && 'text' in reply && /^(?:Settings\n|Settings closed\.|Opening settings…)/.test(reply.text ?? '')))) return false;
    return true;
  }
  private readonly skills: SkillPicker;
  private iconIds?: Promise<Record<TopicActivity, string>>;
  private statusTimer?: NodeJS.Timeout;
  private checkingStatuses = false;
  private updateTail: Promise<void> = Promise.resolve();
  private queuedUpdates = 0;
  private stopped = false;
  private polling?: { controller: TelegramAbortController; done: Promise<void> };
  constructor(private readonly options: BotOptions) {
    this.bot = options.bot ?? new Bot(options.token);
    this.delivery = new TelegramDelivery(options.telegramIntervalMs);
    this.config = options.botConfig;
    this.token = options.token;
    this.skills = new SkillPicker({
      store: options.store, botId: () => this.id, username: () => this.bot.botInfo!.username,
      authorize: (chatId, userId) => this.authorize(chatId, userId),
      instancePath: chatId => this.assignedPath(chatId),
      listSkills: (instancePath, session) => options.runtime.listSkills(instancePath, session),
    });
    this.bot.use(async ctx => {
      if (ctx.chat) {
        const destination = contextDestination(ctx);
        if (destination.kind === 'topic' && destination.threadId === this.options.store.getBotStatusTopic(this.id,ctx.chat.id)) return;
      }
      let callbackAnswered = false;
      const answerCallbackQuery = ctx.answerCallbackQuery.bind(ctx);
      ctx.answerCallbackQuery = async (...args) => {
        const result = await answerCallbackQuery(...args);
        callbackAnswered = true;
        return result;
      };
      const urgent = /^\/terminate(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(messageText(ctx.message) ?? '');
      if (++this.queuedUpdates > 256 && !urgent) { this.queuedUpdates--; return; }
      if (!urgent && this.collectAlbum(ctx)) { this.queuedUpdates--; return; }
      const received = this.receiveMessage(ctx);
      const process = async () => { await received; await this.handle(ctx); };
      const task = urgent ? process() : this.updateTail.then(process);
      if (!urgent) this.updateTail = task.catch(() => undefined);
      try { await task; } catch (error) { await this.reportError(ctx,error); }
      finally {
        this.queuedUpdates--;
        if (ctx.callbackQuery && !callbackAnswered) await ctx.answerCallbackQuery().catch(() => undefined);
      }
    });
  }
  private async reportError(ctx: Context, error: unknown): Promise<void> {
    console.error('Telegram operation failed.', error);
    if (ctx.chat && ctx.message && !/^\/status(?:@|\s|$)/i.test(messageText(ctx.message) ?? '')) {
      const session = this.options.store.getTopic({botId:this.id,destination:contextDestination(ctx)});
      if (session && this.sessionAssigned(session)) this.sessionObservation(session.id).failure = {operation:'Telegram operation',at:Date.now(),error};
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
    }).catch(() => undefined);
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
        const text = pending.contexts.flatMap(part => part.message && 'caption' in part.message && part.message.caption ? [part.message.caption] : []).join('\n\n') || 'Describe this image.';
        this.albumPrompts.set(source,{contexts:pending.contexts,text});
        await this.receiveMessage(source);
        await this.handle(source);
      });
      this.updateTail = task.catch(error => this.reportError(ctx,error)).finally(() => { this.queuedUpdates--; });
    }
    album.contexts.push(ctx);
    clearTimeout(album.timer);
    album.timer = setTimeout(album.resolve,250);
    return true;
  }
  private async receiveMessage(ctx: Context, interaction = false): Promise<void> {
    const message = ctx.message;
    const text = messageText(message);
    const reply = message && 'reply_to_message' in message ? message.reply_to_message : undefined;
    if (reply && ctx.chat && (this.settingsMessages.has(`${ctx.chat.id}:${reply.message_id}`) ||
        (reply.from?.id === this.id && 'text' in reply && /^(?:Settings\n|Settings closed\.|Opening settings…)/.test(reply.text ?? '')))) return;
    if (this.options.config.terminated) return;
    if (this.stopped || !message || !ctx.chat || ctx.chat.type !== 'supergroup' || !ctx.from || ctx.from.is_bot ||
        !text || 'forward_origin' in message || 'forward_date' in message) return;
    if (this.receivedMessages.has(ctx)) return;
    const assigned = findInstance(this.options.config,this.id,ctx.chat.id);
    if (!assigned || !this.options.store.isEnrolled(this.id,ctx.chat.id)) return;
    if (this.options.store.getTopic({botId:this.id,destination:contextDestination(ctx)})?.status === 'detached') return;
    if (!interaction && !this.allMessagesArePrompts(ctx.chat.id) && !text.startsWith('/')) return;
    const promptInput = !text.startsWith('/') || /^\/(?:new|worktree|p)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text);
    if (!interaction && promptInput && !this.usersCanProposePrompts(ctx.chat.id) && !(await this.currentAdmin(ctx))) return;
    await this.delivery.run(ctx.chat.id,
      () => this.bot.api.setMessageReaction(ctx.chat!.id,message.message_id,[{type:'emoji',emoji:'👀'}]),
      () => !this.stopped && findInstance(this.options.config,this.id,ctx.chat!.id)?.path === assigned.path).catch(() => undefined);
    this.receivedMessages.add(ctx);
  }
  async applyTermination(): Promise<void> {
    if (!this.options.config.terminated) { this.termination = undefined; return; }
    this.termination ??= (async () => {
      this.capacityRequests.clear();
      this.promptProposals.clear();
      const sessions = this.options.store.listSessions();
      for (const session of sessions) {
        this.options.store.cancelInitialTask(session.id);
        this.options.store.advanceSessionGeneration(session.id);
        this.dropListener(session.id);
        for (const handler of this.sessionKillHandlers) handler(session.id);
      }
      const results = await Promise.allSettled(sessions.map(session => this.options.runtime.kill(session)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
    })().catch(error => { this.termination = undefined; throw error; });
    await this.termination;
  }
  get id(): number { return this.bot.isInited() ? this.bot.botInfo.id : 0; }
  async sendStatusNotice(chatId: number, text: string, signal?: TelegramAbortSignal): Promise<void> {
    const create = async () => {
      const topic = await this.bot.api.createForumTopic(chatId,'Bot status',{},signal);
      this.options.store.setBotStatusTopic(this.id,chatId,topic.message_thread_id);
      return topic.message_thread_id;
    };
    const threadId = this.options.store.getBotStatusTopic(this.id,chatId) ?? await create();
    try {
      await sendTo(this.bot.api,topicDestination(chatId,threadId),text,undefined,signal);
    } catch (error) {
      if (!(error instanceof GrammyError) || !/message thread not found|TOPIC_DELETED/i.test(error.description)) throw error;
      await sendTo(this.bot.api,topicDestination(chatId,await create()),text,undefined,signal);
    }
  }
  initialize(): Promise<void> {
    return this.initialization ??= this.initializeOnce();
  }
  private async initializeOnce(): Promise<void> {
    if (!this.bot.isInited()) this.bot.botInfo = await this.bot.api.getMe(this.apiAbort.signal);
    await this.bot.api.setMyCommands(
      groupCommands,
      { scope: { type: 'all_group_chats' } },
      this.apiAbort.signal,
    );
    await this.syncCommandMenus();
    if (refreshTermination(this.options.config)) await this.applyTermination();
  }
  startBackground(): void {
    if (this.stopped || this.backgroundStarted) return;
    if (!this.bot.isInited()) throw new Error('Bot identity must be initialized before background maintenance');
    this.backgroundStarted = true;
    this.restoreSessions();
    this.statusTimer ??= setInterval(() => {
      if (this.stopped || this.options.config.terminated || this.checkingStatuses) return;
      this.checkingStatuses = true;
      void this.runBackground('topic-status', async signal => {
        try {
          for (const session of this.options.store.listSessions(this.id)) {
            signal.throwIfAborted();
            if (this.sessionAssigned(session)) await this.refreshTopicStatus(session);
          }
        } finally { this.checkingStatuses = false; }
      });
    }, 30000);
    this.statusTimer.unref();
    void this.refreshSkillCatalogs();
    this.menuTimer ??= setInterval(() => { void this.refreshSkillCatalogs(); }, 60000);
    this.menuTimer.unref();
  }
  private runBackground(phase: string, operation: (signal: AbortSignal) => Promise<void>, signal = this.background.signal): Promise<void> {
    if (signal.aborted || this.stopped) return Promise.resolve();
    const startedAt = performance.now();
    const task = operation(signal).catch(error => {
      if (error !== signal.reason) {
        const failure = {operation:phase,at:Date.now(),error};
        if (phase.startsWith('skills:')) {
          const path = phase.slice('skills:'.length);
          const observation = this.catalogObservations.get(path) ?? {};
          observation.failure = failure;
          observation.failed = true;
          this.catalogObservations.set(path,observation);
        } else if (phase.includes(':')) this.sessionObservation(phase.slice(phase.indexOf(':')+1)).failure = failure;
        console.error(`Bot ${this.id} background ${phase} failed.`, error);
      }
    }).finally(() => {
      this.backgroundTasks.delete(task);
      console.log(JSON.stringify({event:'bot-background',botId:this.id,phase,durationMs:Math.round(performance.now()-startedAt),cancelled:signal.aborted}));
    });
    this.backgroundTasks.add(task);
    return task;
  }
  private restoreSessions(): void {
    for (const existing of this.options.store.listSessions(this.id)) {
      if (this.options.config.terminated || !this.sessionAssigned(existing) || this.listeners.has(existing.id) || this.restoring.has(existing.id)) continue;
      const generation = this.options.store.getSessionGeneration(existing.id);
      this.restoring.add(existing.id);
      void this.runBackground(`restore:${existing.id}`, async signal => {
        try {
          const shouldListen = existing.status === 'open' && (this.options.store.hasPendingInitialTask(existing.id) ||
            await withCancellation(this.options.runtime.isRunning(existing), signal));
          signal.throwIfAborted();
          if (!this.sessionAssigned(existing) || this.options.store.getSessionGeneration(existing.id) !== generation) return;
          if (shouldListen) await withCancellation(this.sendInitial(existing), signal);
          else await this.refreshTopicStatus(existing);
        } catch (error) {
          if (error === signal.reason) throw error;
          if (!this.stopped && !(error instanceof SessionCapacityError) && this.options.store.getSessionGeneration(existing.id) === generation) this.scheduleReconnect(existing);
          throw error;
        }
      }).finally(() => this.restoring.delete(existing.id));
    }
  }
  refreshSkillCatalogs(): Promise<void> {
    if (this.stopped || this.options.config.terminated) return Promise.resolve();
    const signal = this.catalogRefresh.signal;
    const tasks: Promise<void>[] = [];
    for (const [instancePath, instance] of Object.entries(this.options.config.instances)) {
      if (!instance.chats.some(chat => chat.botId === this.id)) continue;
      let task = this.catalogTasks.get(instancePath);
      if (!task) {
        task = this.runBackground(`skills:${instancePath}`, async () => {
          const skills = await withCancellation(this.options.runtime.listSkills(instancePath, undefined, signal), signal);
          signal.throwIfAborted();
          if (!this.options.config.instances[instancePath]?.chats.some(chat => chat.botId === this.id)) return;
          this.options.store.setSkillCatalog(instancePath, skills);
          const observation = this.catalogObservations.get(instancePath) ?? {};
          observation.refreshedAt = Date.now();
          observation.failed = false;
          this.catalogObservations.set(instancePath,observation);
          await this.syncCommandMenus();
        }, signal);
        this.catalogTasks.set(instancePath, task);
        const current = task;
        void task.finally(() => { if (this.catalogTasks.get(instancePath) === current) this.catalogTasks.delete(instancePath); });
      }
      tasks.push(task);
    }
    return Promise.all(tasks).then(() => {});
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
    await this.relayMiniAppText(session,user,`posted a prompt: ${text}`);
  }
  async relayAnswer(session: TopicSession, user: {userId:number;username?:string;displayName:string}, text: string): Promise<void> {
    await this.relayMiniAppText(session,user,`answered: ${text}`);
  }
  private async relayMiniAppText(session: TopicSession, user: {userId:number;username?:string;displayName:string}, text: string): Promise<void> {
    this.requireSessionAssignment(session);
    const author = user.username ? `@${user.username}` : `${user.displayName} (user ID ${user.userId})`;
    const message = `${author} ${text}`;
    for (let offset = 0; offset < message.length;) {
      let end = Math.min(offset+4000,message.length);
      if (end < message.length && message.charCodeAt(end-1) >= 0xD800 && message.charCodeAt(end-1) <= 0xDBFF) end--;
      this.requireSessionAssignment(session);
      await sendTo(this.bot.api, topicDestination(session.chatId, session.threadId),message.slice(offset,end));
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
            await this.bot.api.deleteWebhook({ drop_pending_updates: false }, controller.signal);
            webhookRemoved = true;
          }
          const updates = await this.bot.api.getUpdates({
            offset, timeout: onReady ? 0 : 30, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'inline_query'],
          }, controller.signal);
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
          const temporary = error instanceof GrammyError && (error.error_code === 429 || error.error_code >= 500);
          if (!temporary && !(error instanceof HttpError)) throw error;
          const seconds = error instanceof GrammyError ? error.parameters.retry_after ?? 5 : 5;
          await retryDelay(Math.max(0, seconds) * 1000, controller.signal);
        }
      }
    } finally {
      if (controller.signal.aborted && offset > 0) {
        const acknowledgement = new TelegramAbortController();
        const timeout = setTimeout(() => acknowledgement.abort(), 5000);
        try {
          await this.bot.api.getUpdates({ offset, limit: 1, timeout: 0 }, acknowledgement.signal).catch(() => undefined);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.background.abort(new Error('Bot background maintenance stopped'));
    this.catalogRefresh.abort(new Error('Bot catalog refresh stopped'));
    this.apiAbort.abort();
    this.delivery.close();
    clearInterval(this.statusTimer);
    clearInterval(this.menuTimer);
    for (const album of this.albums.values()) { clearTimeout(album.timer); album.resolve(); }
    this.albums.clear();
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
    await Promise.all(this.backgroundTasks);
    await this.menuTail;
    await Promise.all([...this.topicIcons.values()].map(icon => icon.tail));
  }
  private sessionObservation(id: string): SessionObservation {
    let observation = this.sessionObservations.get(id);
    if (!observation) {
      observation = {};
      this.sessionObservations.set(id,observation);
    }
    return observation;
  }
  private async showStatus(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const destination = contextDestination(ctx);
    const assigned = findInstance(this.options.config,this.id,chatId);
    if (!assigned || !this.options.store.isEnrolled(this.id,chatId)) {
      await replyTo(ctx,destination,`${await this.ready(chatId) ? 'Forum permissions ready.' : 'Enable Topics in a supergroup and grant Manage Topics and Pin Messages.'} Run /setup as a current group owner or administrator to enroll an assigned group or request local assignment approval.`);
      return;
    }
    await this.authorize(chatId,ctx.from!.id,true);
    const path = assigned.path;
    const failures: StatusFailure[] = [];
    const suspended = refreshTermination(this.options.config);
    const lines = [`Bot: ${suspended ? 'online; service terminated' : 'ready'}`];
    try { lines.push(`Forum: ${await this.ready(chatId) ? 'ready' : 'permissions need attention'}`); }
    catch (error) {
      lines.push('Forum: unknown (permission lookup failed)');
      failures.push({operation:'Forum permissions',at:Date.now(),error});
    }
    const stored = this.options.store.getTopic({botId:this.id,destination});
    const session = stored?.instancePath === path ? stored : undefined;
    if (stored && !session) lines.push('Session: unavailable (assigned to another project)');
    else if (session) {
      const observation = this.sessionObservation(session.id);
      const listener = this.listeners.get(session.id);
      lines.push(`Session: ${session.name} (${session.status})`);
      let host = 'unknown';
      if (suspended || session.status === 'detached') {
        host = `unknown (${suspended ? 'service terminated' : 'conversation-only'}; not queried)`;
      } else {
        try {
          host = await withCancellation(this.options.runtime.isRunning(session),AbortSignal.timeout(5000)) ? 'running' : 'stopped';
        } catch (error) {
          observation.failure = {operation:'Host status lookup',at:Date.now(),error};
        }
      }
      lines.push(`Host: ${host}`);
      lines.push(`Mirroring: ${listener?.connection ? 'connected' : listener?.promise ? 'connecting' : observation.mirrored || host === 'running' ? 'disconnected' : 'not attached'}`);
      const task = observation.task?.state ?? (this.options.store.hasPendingInitialTask(session.id) ? 'waiting for host; not submitted' : 'unknown (no task observed in this process)');
      lines.push(`Latest task: ${task}`);
      const recovery = listener?.initial?.phase === 'retrying' ? 'initial task retry scheduled' : this.restoring.has(session.id) ? 'restoring' : this.reconnecting.has(session.id) ? 'reconnecting' : this.reconnects.has(session.id) ? 'reconnect scheduled' : 'not scheduled';
      lines.push(`Recovery: ${recovery}`);
      if (observation.failure) failures.push(observation.failure);
    } else lines.push(destination.kind === 'general' ? 'Session: General has no session' : 'Session: none; use /new task or create a topic');
    const catalog = this.options.store.getSkillCatalog(path);
    const catalogObservation = this.catalogObservations.get(path);
    const freshness = this.catalogTasks.has(path) ? 'refreshing' : catalogObservation?.failed ? 'refresh failed' : catalogObservation?.refreshedAt ? 'current' : 'not checked this process';
    lines.push(`Skill shortcuts: ${catalog ? `saved catalog (${catalog.length} skills); ${freshness}` : `unavailable; ${freshness}`}`);
    lines.push(`Last successful skill check: ${catalogObservation?.refreshedAt ? new Date(catalogObservation.refreshedAt).toISOString() : 'unknown'} (runtime discovery cache may apply)`);
    if (catalogObservation?.failure) failures.push(catalogObservation.failure);
    for (const failure of failures) {
      const error = failure.error instanceof HttpError && failure.error.error instanceof Error ? failure.error.error : failure.error;
      const fields = error instanceof Error ? ['code','signal','killed'].flatMap(key => {
        const value = Reflect.get(error,key);
        return value === undefined || value === null ? [] : [`${key}: ${String(value)}`];
      }) : [];
      const details = failure.error instanceof Error ? failure.error.message : String(failure.error);
      lines.push(`Last failure — ${failure.operation} (${new Date(failure.at).toISOString()}):\n${details}${fields.length ? '\n'+fields.join('\n') : ''}`);
    }
    const text = lines.join('\n');
    for (let offset = 0; offset < text.length;) {
      await this.authorize(chatId,ctx.from!.id,true);
      if (this.assignedPath(chatId) !== path) throw new Error('The group instance assignment changed');
      let end = Math.min(offset+3900,text.length);
      if (end < text.length && text.charCodeAt(end-1) >= 0xD800 && text.charCodeAt(end-1) <= 0xDBFF) end--;
      await replyTo(ctx,destination,text.slice(offset,end));
      offset = end;
    }
  }
  async authorize(chatId: number, userId: number, statusOnly = false): Promise<void> {
    await this.authorizeMember(chatId, userId, statusOnly);
  }
  async authorizeSession(session: TopicSession, userId: number): Promise<boolean> {
    const member = await this.authorizeMember(session.chatId, userId);
    this.requireSessionAssignment(session);
    return isAdministrator(member);
  }
  private async authorizeMember(chatId: number, userId: number, statusOnly = false) {
    if (this.stopped) throw this.background.signal.reason;
    if (refreshTermination(this.options.config) && !statusOnly) throw new Error(terminationMessage);
    const instancePath = this.assignedPath(chatId);
    if (!this.options.store.isEnrolled(this.id, chatId)) throw new Error('Group not enrolled');
    const [chat, user, bot] = await Promise.all([this.bot.api.getChat(chatId), this.bot.api.getChatMember(chatId, userId), this.bot.api.getChatMember(chatId, this.id)]);
    if (refreshTermination(this.options.config) && !statusOnly) throw new Error(terminationMessage);
    if (this.assignedPath(chatId) !== instancePath) throw new Error('The group instance assignment changed');
    if (!isActiveMember(user)) throw new AuthorizationDeniedError('Group access denied');
    if (chat.type !== 'supergroup' || (!statusOnly && (!chat.is_forum || bot.status !== 'administrator' || !bot.can_manage_topics))) throw new Error('Group access denied');
    if (this.stopped) throw this.background.signal.reason;
    if (!this.options.store.isEnrolled(this.id, chatId)) throw new Error('Group not enrolled');
    return user;
  }
  private async ready(chatId: number): Promise<boolean> {
    const [chat, member] = await Promise.all([this.bot.api.getChat(chatId), this.bot.api.getChatMember(chatId, this.id)]);
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
    if (this.stopped) throw this.background.signal.reason;
    if (refreshTermination(this.options.config)) throw new Error(terminationMessage);
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
      : 'Use /p <prompt> or reply to my messages in a session topic. Ordinary messages and mentions are ignored.';
    return `${input}\nIn General, /p works like /new (with a task or an interactive reply).\n${this.usersCanProposePrompts(chatId)
      ? 'Non-admin prompts require approval by a group administrator.'
      : 'Only group administrators can send prompts. Other members’ messages are ignored.'}`;
  }
  private syncCommandMenus(): Promise<void> {
    const operation = this.menuTail.then(() => this.publishCommandMenus());
    this.menuTail = operation.catch(() => {});
    return operation;
  }
  private async publishCommandMenus(): Promise<void> {
    const current = new Set<number>();
    for (const [instancePath, instance] of Object.entries(this.options.config.instances)) {
      const chats = instance.chats.filter(chat => chat.botId === this.id);
      if (!chats.length) continue;
      for (const chat of chats) current.add(chat.chatId);
      const skills = this.options.store.getSkillCatalog(instancePath) ?? [];
      if (this.stopped) return;
      const aliases = new Map([...skillCommandAliases(skills)].slice(0, 100 - groupCommands.length));
      const commands = [...groupCommands, ...[...aliases].map(([command, skill]) => ({
        command, description: `Select /skill:${skill.name}`.slice(0, 256),
      }))];
      const fingerprint = JSON.stringify([instancePath, commands]);
      for (const chat of chats) {
        if (!this.options.config.instances[instancePath]?.chats.some(assigned => assigned.botId === this.id && assigned.chatId === chat.chatId)) continue;
        current.add(chat.chatId);
        if (this.commandMenus.get(chat.chatId) === fingerprint) {
          this.skillAliases.set(chat.chatId, aliases);
          continue;
        }
        await this.bot.api.setMyCommands(commands, {scope:{type:'chat',chat_id:chat.chatId}}, this.apiAbort.signal);
        if (this.stopped || !this.options.config.instances[instancePath]?.chats.some(assigned => assigned.botId === this.id && assigned.chatId === chat.chatId)) continue;
        this.commandMenus.set(chat.chatId, fingerprint);
        this.skillAliases.set(chat.chatId, aliases);
      }
    }
    for (const chatId of this.commandMenus.keys()) {
      if (current.has(chatId)) continue;
      await this.bot.api.deleteMyCommands({scope:{type:'chat',chat_id:chatId}}, this.apiAbort.signal);
      this.commandMenus.delete(chatId);
      this.skillAliases.delete(chatId);
    }
  }
  private async currentAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.from || ctx.from.is_bot || ctx.chat?.type !== 'supergroup') return false;
    return isAdministrator(await this.bot.api.getChatMember(ctx.chat.id, ctx.from.id));
  }
  private async listAdmins(ctx: Context): Promise<void> {
    const destination = contextDestination(ctx);
    const instancePath = this.assignedPath(destination.chatId);
    const roster = await this.bot.api.getChatAdministrators(destination.chatId);
    const lines = ['Group administrators:', ...roster.filter(isAdministrator).map(member =>
      `${member.status === 'creator' ? 'Owner' : 'Administrator'}: ${member.user.username ? `@${member.user.username}` : `${member.user.first_name} (User ${member.user.id})`}`)];
    let chunk = '';
    const deliver = async () => {
      await this.authorize(destination.chatId, ctx.from!.id);
      if (this.assignedPath(destination.chatId) !== instancePath ||
          findInstance(readConfig(this.options.config.configPath), this.id, destination.chatId)?.path !== instancePath) throw new Error('The group instance assignment changed');
      await replyTo(ctx, destination, chunk);
    };
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 3800) { await deliver(); chunk = ''; }
      chunk += `${chunk ? '\n' : ''}${line}`;
    }
    if (chunk) await deliver();
  }
  async reconcileConfiguration(): Promise<void> {
    if (this.stopped) return;
    this.catalogRefresh.abort(new Error('Bot configuration changed'));
    this.catalogRefresh = new AbortController();
    this.catalogTasks.clear();
    for (const session of this.options.store.listSessions(this.id)) {
      if (!this.sessionAssigned(session)) {
        this.dropListener(session.id);
        this.topicIcons.delete(session.id);
        for (const [token, request] of this.capacityRequests) if (request.sessionId === session.id) this.capacityRequests.delete(token);
        for (const handler of this.sessionKillHandlers) handler(session.id);
      }
    }
    if (this.options.config.terminated) { await this.applyTermination(); return; }
    this.termination = undefined;
    await this.syncCommandMenus();
    this.restoreSessions();
    void this.refreshSkillCatalogs();
  }
  private link(session: TopicSession): string {
    return `https://t.me/${this.bot.botInfo!.username}/${this.config.miniAppShortName}?startapp=s_${session.id}`;
  }
  private async getIconIds(): Promise<Record<TopicActivity, string>> {
    this.iconIds ??= (async () => {
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      this.background.signal.addEventListener('abort', abort, {once:true});
      if (this.stopped) abort();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const stickers = await this.bot.api.getForumTopicIconStickers(controller.signal);
        const find = (emoji: string) => {
          const id = stickers.find(sticker => sticker.emoji?.replace(/\uFE0F/g, '') === emoji)?.custom_emoji_id;
          if (!id) throw new Error(`Telegram topic icon unavailable: ${emoji}`);
          return id;
        };
        return { running: find('⚡'), finished: find('🏁') };
      } finally {
        clearTimeout(timeout);
        this.background.signal.removeEventListener('abort', abort);
      }
    })().catch(error => { this.iconIds = undefined; throw error; });
    return this.iconIds;
  }
  private setTopicStatus(session: TopicSession, status: TopicActivity): Promise<void> {
    if (this.stopped || !this.sessionAssigned(session)) return Promise.resolve();
    let icon = this.topicIcons.get(session.id);
    if (!icon) {
      icon = { revision: 0, tail: Promise.resolve() };
      this.topicIcons.set(session.id, icon);
    }
    if (icon.status === status) return icon.tail;
    icon.status = status;
    const current = icon;
    const revision = ++current.revision;
    current.tail = current.tail.then(async () => {
      if (this.stopped || !this.sessionAssigned(session) || current.revision !== revision) return;
      const ids = await this.getIconIds();
      if (this.stopped || !this.sessionAssigned(session) || current.revision !== revision) return;
      await this.delivery.run(session.chatId, async () => {
        const id = status === 'finished' ? this.options.store.getTopicFinishIcon(session.id) ?? ids.finished : ids.running;
        if (this.options.store.getTopicIcon(session.id) === id) return;
        const controller = new TelegramAbortController();
        const abort = () => controller.abort();
        this.background.signal.addEventListener('abort', abort, {once:true});
        if (this.stopped) abort();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          try {
            await this.bot.api.editForumTopic(
              session.chatId, session.threadId, {icon_custom_emoji_id:id}, controller.signal);
          } catch (error) {
            if (!(error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED'))) throw error;
          }
          this.options.store.setTopicIcon(session.id,current.revision === revision ? id : undefined);
        } finally {
          clearTimeout(timeout);
          this.background.signal.removeEventListener('abort', abort);
        }
      }, () => !this.stopped && this.sessionAssigned(session) && current.revision === revision, true);
    }).catch(error => {
      if (current.revision === revision) current.status = undefined;
      console.warn(`Could not update topic status (${session.id}, ${status}).`, error);
    });
    return current.tail;
  }
  private async refreshTopicStatus(session: TopicSession): Promise<void> {
    if (this.stopped || !this.sessionAssigned(session)) return;
    const listener = this.listeners.get(session.id);
    if (listener) this.syncTopicTitle(session,listener);
    else {
      const generation = this.options.store.getSessionGeneration(session.id);
      const revision = this.titleRevisions.get(session.id);
      const title = this.options.store.getPendingSessionTitle(session.id) ?? this.humanTitles.get(session.id) ??
        this.stripTopicStatus(session,session.name);
      await this.projectTopicTitle(session,title,() => !this.stopped && this.sessionAssigned(session) &&
        this.options.store.getSession(session.id)?.status === 'open' &&
        this.options.store.getSessionGeneration(session.id) === generation &&
        this.titleRevisions.get(session.id) === revision);
    }
    let running: boolean;
    try { running = await withCancellation(this.options.runtime.isRunning(session),this.background.signal); }
    catch (error) {
      if (error !== this.background.signal.reason) this.sessionObservation(session.id).failure = {operation:'Host status lookup',at:Date.now(),error};
      throw error;
    }
    if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) return;
    if (!running) {
      this.dropListener(session.id);
      await this.setTopicStatus(session, 'finished');
    } else if (listener?.connection) {
      await this.setTopicStatus(session, listener.activity);
    }
  }
  private async detachSession(session: TopicSession): Promise<void> {
    this.options.store.setPendingSessionTitle(session.id,undefined);
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
      const applied = await this.delivery.run(session.chatId, () => this.bot.api.editForumTopic(
        session.chatId,session.threadId,{icon_custom_emoji_id:''}), () => !this.stopped &&
          this.options.store.getSession(session.id)?.status === 'detached' &&
          findInstance(this.options.config,this.id,session.chatId)?.path === session.instancePath);
      if (applied !== undefined) this.options.store.setTopicIcon(session.id,'');
    } catch (error) {
      if (!(error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED'))) throw error;
      this.options.store.setTopicIcon(session.id,'');
    }
  }
  private async announce(session: TopicSession): Promise<void> {
    this.requireSessionAssignment(session);
    const text = this.allMessagesArePrompts(session.chatId) ? 'Send a message to prompt the agent' : 'Use /p to submit a prompt';
    const message = await sendTo(this.bot.api, topicDestination(session.chatId, session.threadId), text, { reply_markup: { inline_keyboard: [[{ text: 'OPEN AGENT', url: this.link(session) }]] } });
    this.requireSessionAssignment(session);
    await this.bot.api.pinChatMessage(session.chatId, message.message_id, { disable_notification: true });
  }
  private async newSession(ctx: Context, task: string, attached?: { instanceId: string; sessionId: string; instancePath: string }, name?: string, images?: ImageContent[], accepted?: () => void, worktree = false, authority = ctx): Promise<void> {
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const instancePath = this.assignedPath(ctx.chat!.id);
    if (attached && attached.instancePath !== instancePath) throw new Error('The group instance assignment changed');
    if (worktree && attached) throw new Error('Attached sessions cannot create managed worktrees');
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    const title = (name ?? task).replace(/\s+/g, ' ').trim().slice(0, 128) || 'OMP session';
    const initialIcon = task && !worktree ? (await this.getIconIds()).running : undefined;
    if (!(await this.currentAdmin(authority))) throw new Error('Administrator access changed before topic creation.');
    const topic = await this.bot.api.createForumTopic(ctx.chat!.id, title, initialIcon ? {icon_custom_emoji_id:initialIcon} : {});
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    const session = this.options.store.createSession({ botId: this.id, chatId: ctx.chat!.id, threadId: topic.message_thread_id, instancePath }, title, attached ? { kind:'attached', instanceId:attached.instanceId, sessionId:attached.sessionId } : {kind:'managed'}, attached || worktree ? undefined : task, ctx.from!.id, images, authority.from!.id);
    if (worktree) {
      const text = await this.options.runtime.worktree(session, task || undefined);
      this.options.store.setSessionRuntime(session.id, session.runtime);
      task = '';
      await replyTo(ctx,topicDestination(session.chatId,session.threadId),text);
    }
    if (worktree) {
      const sourceKey = this.skills.key(ctx);
      const destinationKey = {...sourceKey,destination:topicDestination(session.chatId,session.threadId)};
      for (const skill of this.options.store.getPendingSkills(sourceKey)) this.options.store.addPendingSkill(destinationKey,skill);
      this.options.store.clearPendingSkills(sourceKey);
      const defaultSkill = this.defaultNewTopicSkill(ctx.chat!.id);
      if (defaultSkill) this.options.store.setNewTopicSkill(session.id,defaultSkill);
    }
    accepted?.();
    if (initialIcon) this.options.store.setTopicIcon(session.id,initialIcon);
    if (task && ctx.message) this.options.store.setReplyTarget(session.id,ctx.message.message_id);
    await replyTo(ctx, contextDestination(ctx), `Topic created: https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`, {
      reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
    });
    await this.announce(session);
    const source = ctx.message;
    if (task && source && 'reply_to_message' in source && source.reply_to_message &&
        (/^\/(?:new|worktree|p|skill_[a-z0-9_]+)(?:@\w+)?(?:\s|$)/i.test(messageText(source) ?? '') ||
          this.directedReplies.has(ctx))) {
      await forwardTo(this.bot.api, topicDestination(session.chatId, session.threadId),
        ctx.chat!.id, source.reply_to_message.message_id);
    }
    if (task) for (const original of this.albumPrompts.get(ctx)?.contexts ?? [ctx]) {
      if (original.message) await forwardTo(this.bot.api, topicDestination(session.chatId, session.threadId),
        ctx.chat!.id, original.message.message_id);
    }
    await this.setTopicStatus(session, task ? 'running' : 'finished');
    await this.listen(session);
    await this.sendInitial(session);
  }
  private async askTask(ctx: Context): Promise<void> {
    if (!(await this.currentAdmin(ctx)) && !this.usersCanProposePrompts(ctx.chat!.id)) return;
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const name = ctx.from!.first_name;
    const message = await replyTo(ctx, contextDestination(ctx), `${name}, what should we work on? Reply to this message with the initial task.`, {
      entities: [{type:'text_mention',offset:0,length:name.length,user:ctx.from!}],
      reply_markup: {force_reply:true,selective:true,input_field_placeholder:'Describe the coding task'},
    });
    this.options.store.addTaskRequest(this.id, contextDestination(ctx), message.message_id, ctx.from!.id);
  }
  private async setup(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.from || ctx.from.is_bot || ctx.chat.type !== 'supergroup') return;
    const member = await this.bot.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (!isActiveMember(member) || member.user.is_bot) return;
    if (!(await this.ready(ctx.chat.id))) {
      await replyTo(ctx, contextDestination(ctx), 'Use a supergroup with Topics enabled, then grant this bot Manage Topics and Pin Messages permissions.', { reply_markup: { inline_keyboard: [[{text:'Check Again',callback_data:'setup:check'}]] } }); return;
    }
    const assigned = findInstance(this.options.config, this.id, ctx.chat.id);
    if (!assigned) {
      if (!(await this.currentAdmin(ctx))) {
        const text = 'Only a current group administrator can request setup for an unassigned forum.';
        if (ctx.callbackQuery) await ctx.answerCallbackQuery(text);
        else await replyTo(ctx, contextDestination(ctx), text);
        return;
      }
      const request = this.options.store.createSetupRequest({ botId: this.id, chatId: ctx.chat.id, userId: member.user.id, ...(member.user.username ? { username: member.user.username.toLowerCase() } : {}), title: ctx.chat.title });
      const quotedPath = "'" + this.options.config.configPath.replaceAll("'", "'\\''") + "'";
      const command = `omp-telegram --config ${quotedPath} approve ${request.code}`;
      await replyTo(ctx, contextDestination(ctx), `Setup requested. Ask the local operator to approve within 10 minutes:\n${command}\nThe operator selects the instance directory locally.`, { entities: [{ type: 'code', offset: 'Setup requested. Ask the local operator to approve within 10 minutes:\n'.length, length: command.length }] });
      return;
    }
    if (!(await this.currentAdmin(ctx))) {
      const text = 'Only a current group owner or administrator can enroll this group.';
      if (ctx.callbackQuery) await ctx.answerCallbackQuery(text);
      else await replyTo(ctx, contextDestination(ctx), text);
      return;
    }
    this.assignedPath(ctx.chat.id);
    this.options.store.enrollGroup(this.id, ctx.chat.id);
    await this.openSettings(ctx);
  }
  async requestCapacity(session: TopicSession, limit: number): Promise<void> {
    if (!this.sessionAssigned(session)) return;
    if (!(this.options.configWritable?.() ?? configWritable(this.options.config.configPath))) {
      const command = `omp-telegram --config '${this.options.config.configPath.replaceAll("'", "'\\''")}' configure`;
      await sendTo(this.bot.api, topicDestination(session.chatId, session.threadId), `OMP session limit reached (${limit}). Configuration is read-only; ask the local operator to change its source or permissions, then run:\n${command}`);
      return;
    }
    const now = Date.now();
    for (const [token, request] of this.capacityRequests) {
      if (request.expires <= now || (request.sessionId === session.id && request.limit !== limit)) this.capacityRequests.delete(token);
      else if (request.sessionId === session.id) return;
    }
    const token = randomBytes(16).toString('base64url');
    const message = await sendTo(this.bot.api, topicDestination(session.chatId, session.threadId),
      `OMP session limit reached (${limit}). Increase the shared configured limit from ${limit} to ${limit * 2}? Confirmation by a group administrator is required. Approval saves the configuration, reconnects this topic and submits any pending initial task. Other instructions must be resent. This request expires in 5 minutes.`,
      { reply_markup: { inline_keyboard: [[
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
      await replyTo(ctx, contextDestination(ctx), 'This capacity request expired. Send a prompt in the topic to request another confirmation.');
      return;
    }
    if (!(await this.currentAdmin(ctx))) {
      await ctx.answerCallbackQuery('Only a current group administrator can confirm or cancel a capacity increase.');
      return;
    }
    await this.authorize(request.chatId,ctx.from!.id);
    this.capacityRequests.delete(token);
    if (action === 'cancel') {
      await replyTo(ctx, contextDestination(ctx), 'Capacity increase cancelled. The session limit is unchanged.');
      return;
    }
    const session = this.options.store.getSession(request.sessionId);
    if (!session || !this.sessionAssigned(session) || session.status !== 'open' || session.chatId !== request.chatId || session.threadId !== request.threadId) return;
    if (!(this.options.configWritable?.() ?? configWritable(this.options.config.configPath))) {
      const command = `omp-telegram --config '${this.options.config.configPath.replaceAll("'", "'\\''")}' configure`;
      await replyTo(ctx, contextDestination(ctx), `Configuration is read-only. The session limit is unchanged. Ask the local operator to change its source or permissions, then run:\n${command}`);
      return;
    }
    const member = await this.bot.api.getChatMember(request.chatId, ctx.from!.id);
    const persisted = readConfig(this.options.config.configPath);
    const assigned = findInstance(persisted, this.id, request.chatId);
    if (!isActiveMember(member) || !assigned ||
        assigned.path !== session.instancePath || !isAdministrator(member)) {
      await replyTo(ctx, contextDestination(ctx), 'The configured instance assignment or administrator access changed. The session limit is unchanged.');
      return;
    }
    if (this.options.runtime.getSessionLimit() !== request.limit || persisted.omp.maxSessions !== request.limit) {
      await replyTo(ctx, contextDestination(ctx), 'The session limit changed. This confirmation is stale; send a prompt to request another confirmation if needed.');
      return;
    }
    writeConfig({ ...persisted, omp: { ...persisted.omp, maxSessions: request.limit * 2 } });
    this.options.config.omp.maxSessions = request.limit * 2;
    this.options.runtime.increaseSessionLimit(request.limit);
    await replyTo(ctx, contextDestination(ctx), `Configured session limit increased from ${request.limit} to ${request.limit * 2}. Reconnecting this topic.`).catch(() => undefined);
    await this.listen(session);
    await this.sendInitial(session);
  }
  private async promptImages(ctx: Context, albumPart = false): Promise<ImageContent[] | undefined> {
    const album = !albumPart && this.albumPrompts.get(ctx);
    if (album) {
      const images = (await Promise.all(album.contexts.map(part => this.promptImages(part,true)))).flatMap(parts => parts ?? []);
      return images.length ? images : undefined;
    }
    const message = ctx.message;
    if (!message) return undefined;
    const photo = message.photo?.length ? message.photo.reduce((largest, size) => size.width * size.height > largest.width * largest.height ? size : largest) : undefined;
    const document = message.document?.mime_type?.startsWith('image/') ? message.document : undefined;
    if (!photo && !document) return undefined;
    const mimeType = photo ? 'image/jpeg' : document!.mime_type!;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error(`Unsupported image type: ${mimeType}`);
    const file = await this.bot.api.getFile((photo ?? document)!.file_id);
    if (!file.file_path) throw new Error('Telegram image file path is unavailable');
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram image download failed: ${response.status} ${response.statusText}\n${await response.text()}`);
    return [{type:'image',data:Buffer.from(await response.arrayBuffer()).toString('base64'),mimeType}];
  }
  private defaultNewTopicSkill(chatId: number): string | undefined {
    return findInstance(this.options.config,this.id,chatId)?.instance.chats
      .find(chat => chat.botId === this.id && chat.chatId === chatId)?.default_new_topic_skill;
  }
  private async routePrompt(ctx: Context, text: string, session?: TopicSession, immediateSkill?: string, worktree = false): Promise<void> {
    const admin = await this.currentAdmin(ctx);
    if (!admin && !this.usersCanProposePrompts(ctx.chat!.id)) return;
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    await this.receiveMessage(ctx,true);
    if (session) {
      this.requireSessionAssignment(session);
      if (session.status !== 'open') { await replyTo(ctx, contextDestination(ctx), 'This session is archived. Reopen the topic before sending instructions.'); return; }
    }
    const instancePath = this.assignedPath(ctx.chat!.id);
    const generation = session ? this.options.store.getSessionGeneration(session.id) : undefined;
    const skillKey = this.skills.key(ctx);
    const pendingSkills = this.options.store.getPendingSkills(skillKey);
    const topicSkill = worktree ? undefined : session ? this.options.store.getNewTopicSkill(session.id) : this.defaultNewTopicSkill(ctx.chat!.id);
    const mentionedSkills = worktree ? [] : [...new Set([...(topicSkill ? [topicSkill] : []), ...pendingSkills, ...(immediateSkill ? [immediateSkill] : [])])];
    if (mentionedSkills.length) {
      const available = await this.options.runtime.listSkills(instancePath, session);
      const missing = mentionedSkills.filter(name => !available.some(skill => skill.name === name));
      if (missing.length) throw new Error(`Skills are no longer available: ${missing.map(name => `/skill:${name}`).join(', ')}. Use /skills clear for explicit selections. Restore a missing topic-default skill, or create a new topic after changing the forum default.`);
      text = `${mentionedSkills.map(name => `/skill:${name}`).join(' ')}\n\n${text}`;
    }
    const images = worktree ? undefined : await this.promptImages(ctx);
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    if (session && (this.options.store.getSessionGeneration(session.id) !== generation ||
        this.options.store.getSession(session.id)?.status !== 'open')) throw new Error('The session changed while downloading the image');
    if (await this.currentAdmin(ctx)) {
      if (session) {
        await this.submitSessionPrompt(ctx, session, text, images, {key:skillKey,names:pendingSkills,topicSkill});
      } else await this.newSession(ctx, text, undefined, undefined, images, !worktree && text ? () => this.options.store.clearPendingSkills(skillKey) : undefined, worktree);
      return;
    }
    if (!this.usersCanProposePrompts(ctx.chat!.id)) return;
    const now = Date.now();
    for (const [token, proposal] of this.promptProposals) if (proposal.expires <= now) this.promptProposals.delete(token);
    const token = randomBytes(16).toString('base64url');
    await this.authorize(ctx.chat!.id,ctx.from!.id);
    const message = await replyTo(ctx, contextDestination(ctx), 'Approve this prompt?', {
      reply_parameters:{message_id:ctx.message!.message_id,allow_sending_without_reply:true},
      reply_markup:{inline_keyboard:[[{text:'Approve prompt',callback_data:`prompt:approve:${token}`}]]},
    });
    this.promptProposals.set(token, {
      source:ctx,text,images,instancePath,worktree,
      ...(session ? {sessionId:session.id,generation:this.options.store.getSessionGeneration(session.id)} : {}),
      allMessagesArePrompts:this.allMessagesArePrompts(ctx.chat!.id),messageId:message.message_id,expires:now+600000,
    });
    if (!worktree) this.options.store.clearPendingSkills(skillKey);
    if (session && topicSkill) this.options.store.clearNewTopicSkill(session.id);
  }
  private async approvePrompt(ctx: Context, token: string): Promise<void> {
    const proposal = this.promptProposals.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!proposal || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== proposal.source.chat!.id || message.message_id !== proposal.messageId ||
        !sameTopicDestination(contextDestination(ctx), contextDestination(proposal.source)) ||
        !('from' in message) || message.from?.id !== this.id || 'forward_origin' in message || 'forward_date' in message) return;
    if (!(await this.currentAdmin(ctx))) {
      await ctx.answerCallbackQuery('Only an admin authorized for the target session or new-topic creation can approve this prompt.');
      return;
    }
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
    await ctx.editMessageReplyMarkup({reply_markup:{inline_keyboard:[]}});
    if (!(await this.currentAdmin(ctx))) throw new Error('Administrator access changed before prompt approval.');
    if (session) {
      if (!(await this.submitSessionPrompt(proposal.source,session,proposal.text,proposal.images,undefined,ctx))) {
        await ctx.editMessageText('Prompt not submitted: the initial task is still being admitted. Propose it again after startup.');
        return;
      }
    } else await this.newSession(proposal.source,proposal.text,undefined,undefined,proposal.images,undefined,proposal.worktree,ctx);
    await ctx.editMessageText('Prompt approved.',{reply_markup:{inline_keyboard:[]}});
  }
  private async submitSessionPrompt(ctx: Context, session: TopicSession, prompt: string, images?: ImageContent[], selected?: {key:PendingSkillKey;names:string[];topicSkill?:string}, authority = ctx): Promise<boolean> {
    await this.authorize(ctx.chat!.id,ctx.from!.id);
    this.requireSessionAssignment(session);
    await this.listen(session);
    await this.authorize(ctx.chat!.id,ctx.from!.id);
    if (!(await this.currentAdmin(authority))) throw new Error('Administrator access changed before prompt submission.');
    if (this.listeners.get(session.id)?.initial) {
      await replyTo(ctx, contextDestination(ctx), 'The initial task is still being admitted. Wait for the host to start before sending another instruction.');
      return false;
    }
    const previousTarget = this.options.store.getReplyTarget(session.id);
    const messageId = ctx.message!.message_id;
    this.options.store.setReplyTarget(session.id,messageId);
    const restore = selected && (selected.names.length || selected.topicSkill) ? () => {
      if (selected.names.length) {
        const current = this.options.store.getPendingSkills(selected.key);
        this.options.store.clearPendingSkills(selected.key);
        for (const name of [...selected.names, ...current]) this.options.store.addPendingSkill(selected.key, name);
      }
      if (selected.topicSkill) this.options.store.setNewTopicSkill(session.id,selected.topicSkill);
    } : undefined;
    if (selected) {
      this.options.store.clearPendingSkills(selected.key);
      if (selected.topicSkill) this.options.store.clearNewTopicSkill(session.id);
    }
    try {
      this.sendPrompt(this.listeners.get(session.id)!,prompt,messageId,images,restore);
    } catch (error) {
      this.options.store.setReplyTarget(session.id,previousTarget);
      restore?.();
      throw error;
    }
    return true;
  }
  private async handle(ctx: Context): Promise<void> {
    if (this.stopped) return;
    const statusCommand = messageText(ctx.message)?.match(/^\/status(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (statusCommand && ctx.chat && ctx.chat.type !== 'private' && ctx.from && !ctx.from.is_bot && ctx.message &&
        !('forward_origin' in ctx.message) && !('forward_date' in ctx.message)) {
      if (statusCommand[1] && statusCommand[1].toLowerCase() !== this.bot.botInfo!.username.toLowerCase()) return;
      if (statusCommand[2]?.trim()) { await replyTo(ctx,contextDestination(ctx),'Usage: /status'); return; }
      await this.showStatus(ctx);
      return;
    }
    if (refreshTermination(this.options.config)) {
      try { await this.applyTermination(); }
      finally {
        if (ctx.chat && (ctx.callbackQuery || messageText(ctx.message))) await replyTo(ctx, contextDestination(ctx), terminationMessage);
      }
      return;
    }
    this.termination = undefined;
    if (ctx.inlineQuery) { await this.skills.inline(ctx); return; }
    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.data === undefined || !ctx.chat || !ctx.from || ctx.from.is_bot) return;
      if (ctx.callbackQuery.data.startsWith('skills:')) {
        const message = 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
        if (ctx.chat.type !== 'supergroup' || !this.options.store.isEnrolled(this.id, ctx.chat.id)) return;
        const session = this.options.store.getTopic({botId:this.id,destination:contextDestination(ctx)});
        if (session?.status === 'detached') return;
        await this.skills.callback(ctx, ctx.callbackQuery.data, session);
        return;
      }
      if (ctx.callbackQuery.data.startsWith('settings:')) { await this.settingsCallback(ctx,ctx.callbackQuery.data); return; }
      if (ctx.callbackQuery.data === 'setup:check') {
        const message = 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
        if (message && 'from' in message && message.from?.id === this.id && !('forward_origin' in message) && !('forward_date' in message)) await this.setup(ctx);
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
      if (ctx.chat && ['administrator','member'].includes(ctx.myChatMember.new_chat_member.status)) await replyTo(ctx, contextDestination(ctx), 'A current group administrator can run /setup to request instance assignment from the local operator.');
      return;
    }
    const message = ctx.message;
    if (!message || !ctx.chat) return;
    const topicLifecycle = 'forum_topic_created' in message || 'forum_topic_edited' in message || 'forum_topic_closed' in message || 'forum_topic_reopened' in message;
    if ('forward_origin' in message || 'forward_date' in message || (ctx.from?.is_bot && !topicLifecycle)) return;
    if (await this.settingsReply(ctx)) return;
    const text = this.albumPrompts.get(ctx)?.text ?? messageText(message);
    if (text && !text.startsWith('/') && this.options.store.getTopic({
      botId:this.id,destination:contextDestination(ctx),
    })?.status === 'detached') {
      if (ctx.from && 'reply_to_message' in message && message.reply_to_message &&
          this.options.store.takeTaskRequest(this.id,contextDestination(ctx),message.reply_to_message.message_id,ctx.from.id)) {
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
        else await replyTo(ctx, contextDestination(ctx), 'Use the numbered answer buttons on the question.');
        return;
      }
      if (this.endedQuestionReplies.has(`${ctx.chat.id}:${replyId}`)) {
        await this.authorize(ctx.chat.id, ctx.from.id);
        await replyTo(ctx, contextDestination(ctx), 'This question is no longer active. Answer the latest question instead.');
        return;
      }
    }
    if (ctx.from && text && !text.startsWith('/') && 'reply_to_message' in message && message.reply_to_message &&
        this.options.store.takeTaskRequest(this.id,contextDestination(ctx),message.reply_to_message.message_id,ctx.from.id)) {
      await this.routePrompt(ctx,text);
      return;
    }
    const directedReply = text && !text.startsWith('/') && 'reply_to_message' in message &&
      message.reply_to_message?.from?.id === this.id &&
      !('forum_topic_created' in message.reply_to_message) &&
      message.reply_to_message.message_id !== message.message_thread_id;
    if (directedReply) this.directedReplies.add(ctx);
    const command = (directedReply ? `/p ${text}` : text)?.match(/^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (command?.[2] && command[2].toLowerCase() !== this.bot.botInfo!.username.toLowerCase()) return;
    if (command?.[1]?.toLowerCase() === 'terminate') {
      if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, contextDestination(ctx), 'Termination requires a current group administrator.'); return; }
      const member = await this.bot.api.getChatMember(ctx.chat.id, ctx.from!.id);
      const persisted = readConfig(this.options.config.configPath);
      const assigned = findInstance(persisted, this.id, ctx.chat.id);
      if (!assigned || assigned.path !== this.assignedPath(ctx.chat.id) || !isAdministrator(member)) {
        await replyTo(ctx, contextDestination(ctx), 'Termination requires a current group administrator.');
        return;
      }
      persisted.terminated = true;
      writeConfig(persisted);
      this.options.config.terminated = true;
      try { await this.applyTermination(); }
      finally { await replyTo(ctx, contextDestination(ctx), terminationMessage); }
      return;
    }
    if (ctx.chat.type === 'private') {
      await replyTo(ctx, contextDestination(ctx), 'Add me to your own supergroup, enable Topics, grant Manage Topics and Pin Messages, then run /setup. Configure the Mini App URL in BotFather for this bot.', {reply_markup:{inline_keyboard:[[{text:'Add to Group',url:`https://t.me/${this.bot.botInfo!.username}?startgroup=setup&admin=manage_topics+pin_messages`}]]}}); return;
    }
    if (command?.[1]?.toLowerCase() === 'setup') { await this.setup(ctx); return; }
    const assigned = findInstance(this.options.config, this.id, ctx.chat.id);
    if (!assigned || !this.options.store.isEnrolled(this.id, ctx.chat.id)) {
      if (command?.[1]?.toLowerCase() === 'help') {
        await replyTo(ctx, contextDestination(ctx), `${help}\n${settingsHelp}\n${adminHelp}\n${this.promptHelp(ctx.chat.id)}`);
      }
      return;
    }
    if (command?.[1]?.toLowerCase() === 'settings') { await this.openSettings(ctx); return; }
    const destination = contextDestination(ctx);
    let session = this.options.store.getTopic({botId:this.id,destination});
    const detached = session?.status === 'detached';
    if (session && !detached) this.requireSessionAssignment(session);
    if (detached && topicLifecycle && !('forum_topic_edited' in message)) return;
    if (message.forum_topic_created && destination.kind === 'topic') {
      if (!session) {
        session = this.options.store.createSession({botId:this.id,chatId:destination.chatId,threadId:destination.threadId,instancePath:this.assignedPath(ctx.chat.id)}, message.forum_topic_created.name);
        const defaultSkill = this.defaultNewTopicSkill(ctx.chat.id);
        if (defaultSkill) this.options.store.setNewTopicSkill(session.id,defaultSkill);
        await this.announce(session);
        await this.setTopicStatus(session, 'finished');
        await this.refreshTopicStatus(session);
      }
      return;
    }
    if (session && message.forum_topic_edited) {
      const edited = message.forum_topic_edited;
      if (edited.icon_custom_emoji_id !== undefined && ctx.from?.id !== this.id) {
        this.options.store.setTopicFinishIcon(session.id,edited.icon_custom_emoji_id);
        this.options.store.setTopicIcon(session.id,edited.icon_custom_emoji_id);
        const icon = this.topicIcons.get(session.id);
        if (icon) {
          const status = icon.status;
          ++icon.revision;
          icon.status = undefined;
          if (status && !detached) void this.setTopicStatus(session,status);
        }
      }
      if (edited.name && ctx.from?.id !== this.id) {
        const title = this.stripTopicStatus(session,edited.name);
        const listener = this.listeners.get(session.id);
        if (listener) listener.sessionTitle = title;
        this.humanTitles.set(session.id,title);
        this.options.store.updateSession(session.id, {name:edited.name});
        this.titleRevisions.set(session.id,(this.titleRevisions.get(session.id) ?? 0)+1);
        if (!detached) {
          this.options.store.setPendingSessionTitle(session.id,title);
          const revision = this.titleRevisions.get(session.id);
          const generation = this.options.store.getSessionGeneration(session.id);
          await this.projectTopicTitle(session,title,() => !this.stopped && !refreshTermination(this.options.config) &&
            this.sessionAssigned(session) && this.options.store.getSession(session.id)?.status === 'open' &&
            this.titleRevisions.get(session.id) === revision &&
            this.options.store.getSessionGeneration(session.id) === generation);
          await this.applySessionTitle(session);
        }
      }
      if (ctx.from?.id === this.id && edited.icon_custom_emoji_id !== undefined && edited.name === undefined) {
        await this.delivery.run(ctx.chat.id,
          () => this.bot.api.deleteMessage(ctx.chat!.id,message.message_id),
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
    if (!detached && await this.skills.message(ctx, text, session)) return;
    const allMessagesArePrompts = this.allMessagesArePrompts(ctx.chat.id);
    let prompt = '';
    if (command) {
      await this.authorize(ctx.chat.id, ctx.from.id);
      const action = command[1]!.toLowerCase();
      let arg = command[3]?.trim() ?? '';
      if (action === 'list_admins') {
        if (arg) { await replyTo(ctx, destination, 'Usage: /list_admins'); return; }
        await this.listAdmins(ctx);
        return;
      }
      const skillAlias = this.skillAliases.get(ctx.chat.id)?.get(action);
      if (skillAlias) {
        if (detached) { await replyTo(ctx, contextDestination(ctx), 'This topic is conversation-only. Select skills in General or a session topic.'); return; }
        if (!arg) {
          await this.skills.choose(ctx, skillAlias.name, session);
          return;
        }
      }
      if (action === 'skills') {
        if (detached) { await replyTo(ctx, contextDestination(ctx), 'This topic is conversation-only. Use /skills in General or a session topic.'); return; }
        if (arg && arg !== 'clear') { await replyTo(ctx, contextDestination(ctx), 'Usage: /skills or /skills clear'); return; }
        await this.skills.open(ctx, session, arg === 'clear');
        return;
      }
      if ((action === 'p' || action === 'new' || skillAlias) && 'reply_to_message' in message && message.reply_to_message) {
        const reply = message.reply_to_message;
        const quoted = 'text' in reply ? reply.text : 'caption' in reply ? reply.caption : undefined;
        if (quoted) {
          const quote = quoted.split(/\r?\n/).map(line => `> ${line}`).join('\n');
          arg = arg ? `${quote}\n\n${arg}` : quote;
        }
      }
      if (skillAlias) {
        if (destination.kind !== 'general' && !session) {
          await replyTo(ctx, destination, 'No session in this topic. Use /new to create one.');
          return;
        }
        await this.routePrompt(ctx,arg,destination.kind === 'general' ? undefined : session,skillAlias.name);
        return;
      }
      if (action === 'detach') {
        if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, contextDestination(ctx), 'Detaching requires a group administrator.'); return; }
        if (destination.kind === 'general' || !session) { await replyTo(ctx, contextDestination(ctx), 'Use /detach inside a session topic, not General or an unrelated chat.'); return; }
        await this.detachSession(session);
        await replyTo(ctx, contextDestination(ctx), 'This topic is now conversation-only. Session links, prompts, and mirroring are disabled. Host history is preserved; the host was not killed.');
        return;
      }
      if (detached && !['new','worktree','attach','help','start'].includes(action)) {
        await replyTo(ctx, contextDestination(ctx), 'This topic is conversation-only. Use /new to create a separate session topic.');
        return;
      }
      if ((action === 'new' || action === 'p') && !this.usersCanProposePrompts(ctx.chat.id) &&
          !(await this.currentAdmin(ctx))) return;
      if (action === 'new' || (action === 'p' && destination.kind === 'general')) { if (arg) await this.routePrompt(ctx,arg); else await this.askTask(ctx); return; }
      if (action === 'worktree') {
        if (destination.kind === 'general') { await this.routePrompt(ctx,arg,undefined,undefined,true); return; }
        if (!session || detached) { await replyTo(ctx,destination,'Use /worktree inside an active session topic, or General to create one.'); return; }
        if (!(await this.currentAdmin(ctx))) { await replyTo(ctx,destination,'Worktree commands require a group administrator.'); return; }
        await this.authorize(ctx.chat.id,ctx.from.id);
        this.requireSessionAssignment(session);
        if (session.status !== 'open') throw new Error('This session is archived. Reopen the topic before creating a worktree.');
        let text: string;
        try {
          text = await this.options.runtime.worktree(session,arg || undefined);
          this.options.store.setSessionRuntime(session.id,session.runtime);
        } finally {
          this.dropListener(session.id);
        }
        await this.listen(session);
        await replyTo(ctx,destination,text);
        return;
      }
      if (action === 'attach') {
        if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, contextDestination(ctx), 'Attaching requires a group administrator.'); return; }
        const match = arg.match(/^([A-Za-z0-9_-]+)(?:\s+(.+))?$/);
        if (!match) { await replyTo(ctx, contextDestination(ctx), 'Usage: /attach instanceId [topic name]. Get the instance ID from omp collab list.'); return; }
        const instancePath = this.assignedPath(ctx.chat.id);
        const binding = await this.options.runtime.attach(match[1]!, instancePath);
        await this.newSession(ctx,'',{instanceId:binding.instanceId,sessionId:binding.sessionId,instancePath},match[2] ?? 'Attached OMP session'); return;
      }
      if (action === 'help' || action === 'start') { await replyTo(ctx, contextDestination(ctx), `${help}\n${settingsHelp}\n${adminHelp}\n/skills — select or clear skills for your next prompt\n/skill_* — select a skill; include task text to submit immediately\n${this.promptHelp(ctx.chat.id)}`); return; }
      if (action === 'session') {
        if (!session) { await replyTo(ctx, contextDestination(ctx), 'No session in this topic. Use /new task or create a topic.'); return; }
        await replyTo(ctx, contextDestination(ctx), `${session.name} (${session.status})`,{reply_markup:{inline_keyboard:[[{text:'OPEN AGENT',url:this.link(session)}]]}}); return;
      }
      if (action === 'model_preset' || action === 'list_model_presets') {
        if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, contextDestination(ctx), 'Model preset commands require a group administrator.'); return; }
        if (destination.kind !== 'topic' || !session) { await replyTo(ctx, contextDestination(ctx), `Use /${action} in a session topic. Use /settings for forum defaults.`); return; }
        if (session && session.status !== 'open') { await replyTo(ctx, contextDestination(ctx), 'This session is archived. Reopen the topic before using model preset commands.'); return; }
        if (action === 'model_preset' ? !/^[A-Za-z][\w-]*$/.test(arg) : Boolean(arg)) {
          await replyTo(ctx, contextDestination(ctx), action === 'model_preset' ? 'Usage: /model_preset <name> (a letter, then letters, digits, - or _)' : 'Usage: /list_model_presets');
          return;
        }
        if (!session) return;
        const generation = this.options.store.getSessionGeneration(session.id);
        const release = this.options.runtime.retain(session.id);
        try {
          await this.options.runtime.ensure(session);
          await this.authorize(ctx.chat.id,ctx.from.id);
          if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, contextDestination(ctx), 'Model preset commands require a group administrator.'); return; }
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
            await replyTo(ctx, contextDestination(ctx), text.slice(offset,end));
            offset = end;
          }
        } finally { release(); }
        return;
      }
      if (action === 'stop' || action === 'kill') {
        if (destination.kind === 'general' || !session) { await replyTo(ctx, contextDestination(ctx), `Use /${action} inside a session topic, not General or an unrelated chat.`); return; }
        this.requireSessionAssignment(session);
        if (action === 'stop' && session.status !== 'open') { await replyTo(ctx, contextDestination(ctx), 'This session is archived. Reopen the topic before sending instructions.'); return; }
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
          await this.setTopicStatus(session, 'finished');
          await replyTo(ctx, contextDestination(ctx), 'Session process killed. History is preserved; a managed session can restart on your next instruction or OPEN AGENT visit.');
          return;
        }
        if (!(await this.options.runtime.isRunning(session))) {
          this.dropListener(session.id);
          await this.setTopicStatus(session, 'finished');
          await replyTo(ctx, contextDestination(ctx), 'Session is not running.');
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
        await replyTo(ctx, contextDestination(ctx), 'Abort requested. The session process is still running.');
        return;
      }
      if (action !== 'p') return;
      if (!session) { await replyTo(ctx, contextDestination(ctx), 'Use /p inside a session topic, or in General to create a new session.'); return; }
      if (!arg) { await replyTo(ctx, contextDestination(ctx), 'Usage: /p <prompt>'); return; }
      prompt = arg;
    } else {
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
    if (this.stopped || this.options.config.terminated || !this.sessionAssigned(session)) return;
    const current = this.options.store.getSession(session.id);
    if (current?.status !== 'open' || this.reconnects.has(session.id)) return;
    if (attempt >= 5) {
      void sendTo(this.bot.api, topicDestination(session.chatId, session.threadId), `Session mirroring disconnected. Send a prompt to reconnect to the local host. ${this.promptHelp(session.chatId)}`).catch(() => undefined);
      return;
    }
    const generation = this.options.store.getSessionGeneration(session.id);
    const timer = setTimeout(() => {
      this.reconnects.delete(session.id);
      if (this.stopped || !this.sessionAssigned(session) || this.options.store.getSessionGeneration(session.id) !== generation) return;
      const active = this.options.store.getSession(session.id);
      if (active?.status !== 'open') return;
      this.reconnecting.add(active.id);
      void this.runBackground(`reconnect:${active.id}`, async signal => {
        try {
          const running = await withCancellation(this.options.runtime.isRunning(active), signal);
          signal.throwIfAborted();
          if (!this.sessionAssigned(active) || this.options.store.getSessionGeneration(active.id) !== generation) return;
          if (running && this.options.store.getSession(active.id)?.status === 'open') await withCancellation(this.sendInitial(active), signal);
          if (!running) await this.setTopicStatus(active, 'finished');
        } catch (error) {
          if (error !== signal.reason && !this.stopped && !(error instanceof SessionCapacityError) && this.options.store.getSessionGeneration(active.id) === generation) this.scheduleReconnect(active, attempt + 1);
          throw error;
        }
      }).finally(() => this.reconnecting.delete(active.id));
    }, Math.min(1000 * 2 ** attempt, 16000));
    timer.unref();
    this.reconnects.set(session.id, timer);
  }
  private dropListener(id: string): void {
    clearTimeout(this.reconnects.get(id));
    this.reconnects.delete(id);
    const listener = this.listeners.get(id);
    for (const pending of listener?.pendingPrompts ?? []) pending.observation.state = 'acceptance unknown';
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
    const listener: Listener = {sessionId:session.id,tail:Promise.resolve(),queued:0,recovering:this.options.store.hasSnapshot(session.id),pendingPrompts:[],pendingAnswers:new Map(),pendingStops:[],queuedMessages:0,activity:'finished'};
    this.listeners.set(session.id, listener);
    listener.promise = (binding ? Promise.resolve(binding) : this.options.runtime.ensure(session)).then(async binding => {
      await this.applySessionTitle(session);
      this.requireSessionAssignment(session);
      return (this.options.connect ?? connectCollab)(binding,`Telegram @${this.bot.botInfo!.username}`,{
      onFrame: frame => this.onFrame(session,listener,frame),
      onClose: reason => {
        if (this.listeners.get(session.id) !== listener) return;
        this.sessionObservation(session.id).failure = {operation:'Mirroring disconnected',at:Date.now(),error:reason};
        const connected = listener.connection !== undefined;
        this.dropListener(session.id);
        void this.runBackground(`topic-status:${session.id}`, () => this.refreshTopicStatus(session));
        if (connected) this.scheduleReconnect(session);
      },
    }); }).then(connection => {
      if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) { connection.close(); throw new Error('Session closed'); }
      this.sessionObservation(session.id).mirrored = true;
      listener.connection = connection; return connection;
    }).catch(async error => {
      if (!this.stopped) this.sessionObservation(session.id).failure = {operation:'Session connection',at:Date.now(),error};
      try {
        if (error instanceof SessionCapacityError && !this.stopped) await this.requestCapacity(session,error.limit);
        throw error;
      } finally {
        if (this.listeners.get(session.id) === listener) this.listeners.delete(session.id);
        await this.refreshTopicStatus(session).catch(error => console.error(`Topic status refresh failed (${session.id}).`, error));
      }
    });
    return listener.promise;
  }
  private sendPrompt(listener: Listener, text: string, messageId?: number, images?: ImageContent[], onStartupRejected?: () => void): void {
    const session = this.options.store.getSession(listener.sessionId);
    if (!session) throw new Error('Session no longer exists');
    this.requireSessionAssignment(session);
    const observation: TaskObservation = {state:'waiting for acceptance'};
    this.sessionObservation(session.id).task = observation;
    const pending = {text,messageId,onStartupRejected,observation};
    listener.pendingPrompts.push(pending);
    let attempted = false;
    try {
      this.options.runtime.markPrompt(listener.sessionId);
      attempted = true;
      listener.connection!.send({t:'prompt',text,...(images?.length ? {images} : {})});
    } catch (error) {
      observation.state = attempted ? 'acceptance unknown' : 'not accepted';
      const index = listener.pendingPrompts.indexOf(pending);
      if (index !== -1) listener.pendingPrompts.splice(index,1);
      throw error;
    }
  }
  private async authorizeInitial(session: TopicSession, userId: number, authorityUserId: number): Promise<void> {
    try {
      await this.authorize(session.chatId, userId);
      if (!isAdministrator(await this.bot.api.getChatMember(session.chatId, authorityUserId))) {
        throw new AuthorizationDeniedError('Administrator access changed before initial task submission.');
      }
      this.requireSessionAssignment(session);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) this.options.store.cancelInitialTask(session.id);
      throw error;
    }
  }
  private async sendInitial(session: TopicSession): Promise<void> {
    this.requireSessionAssignment(session);
    await this.listen(session);
    if (this.stopped) throw this.background.signal.reason;
    if (!this.options.store.hasPendingInitialTask(session.id)) return;
    const userId = this.options.store.getInitialUser(session.id);
    const authorityUserId = this.options.store.getInitialAuthority(session.id);
    if (!userId || !authorityUserId) {
      this.options.store.cancelInitialTask(session.id);
      throw new Error('Initial task has no authorizing administrator. Submit the task again.');
    }
    await this.authorizeInitial(session, userId, authorityUserId);
    this.options.runtime.markPrompt(session.id);
    const task = this.options.store.claimInitialTask(session.id);
    if (!task) return;
    const listener = this.listeners.get(session.id)!;
    const messageId = this.options.store.getReplyTarget(session.id);
    const images = this.options.store.getInitialImages(session.id);
    listener.initial = {text:task,images,userId,authorityUserId,messageId,deadline:Date.now()+this.options.config.omp.startupTimeoutMs,retries:0,phase:'sent'};
    listener.initial.timer = setTimeout(() => { listener.initial = undefined; },this.options.config.omp.startupTimeoutMs);
    listener.initial.timer.unref();
    this.sendPrompt(listener,task,messageId,images);
  }
  private acknowledgeMessage(session: TopicSession, messageId: number, listener?: Listener): void {
    void this.delivery.run(session.chatId,
      () => this.bot.api.setMessageReaction(session.chatId,messageId,[{type:'emoji',emoji:'🤝'}]),
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
          () => this.bot.api.editMessageReplyMarkup(question.session.chatId,messageId,{reply_markup:{inline_keyboard:[]}}),
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
              () => this.bot.api.editMessageText(question.session.chatId,receiptId,text,{reply_markup:{inline_keyboard:[]}}),
              () => !this.stopped && this.sessionAssigned(question.session));
          } else {
            await this.delivery.run(question.session.chatId,
              () => sendTo(this.bot.api, topicDestination(question.session.chatId, question.session.threadId),text,{
                
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
    this.requireSessionAssignment(question.session);
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
      await ctx.answerCallbackQuery('This question is no longer active.');
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
    await ctx.answerCallbackQuery();
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
          () => sendTo(this.bot.api, topicDestination(session.chatId, session.threadId),body.slice(offset,end)),active);
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
          () => sendTo(this.bot.api, topicDestination(session.chatId, session.threadId),
            request.kind === 'editor' ? 'You can type a custom answer below, or cancel here.' : 'Choose an answer by number:', {
              
              reply_markup:{inline_keyboard:keyboard},
            }), active);
        if (!message) return;
        question.messageIds.push(message.message_id);
        question.buttonIds.push(message.message_id);
        if (!active()) {
          void this.delivery.run(session.chatId,
            () => this.bot.api.editMessageReplyMarkup(session.chatId,message.message_id,{reply_markup:{inline_keyboard:[]}}),
            () => !this.stopped && this.sessionAssigned(session)).catch(() => undefined);
        }
      }
      if (request.kind === 'editor' && active()) {
        const message = await this.delivery.run(session.chatId,
          () => sendTo(this.bot.api, topicDestination(session.chatId, session.threadId),'Reply here with your answer. Multiline text is supported.',{
            
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
  private async applySessionTitle(session: TopicSession): Promise<void> {
    const title = this.options.store.getPendingSessionTitle(session.id);
    if (title === undefined || this.stopped || refreshTermination(this.options.config) ||
        !this.sessionAssigned(session) || this.options.store.getSession(session.id)?.status !== 'open') return;
    try {
      await this.options.runtime.setSessionTitle(session,title);
    } catch (error) {
      this.sessionObservation(session.id).failure = {operation:'Session title synchronization',at:Date.now(),error};
      if (error instanceof SessionTitleUnsupportedError && this.options.store.getPendingSessionTitle(session.id) === title) {
        this.options.store.setPendingSessionTitle(session.id,undefined);
      }
    }
  }
  private stripTopicStatus(session: TopicSession, title: string): string {
    const worktree = /^wt:[^\s]*(?:\s+|$)/.exec(title);
    if (worktree) return title.slice(worktree[0].length);
    const savedPrefix = this.options.store.getTopicTitlePrefix(session.id);
    if (savedPrefix && title.startsWith(`${savedPrefix} `)) return title.slice(savedPrefix.length+1);
    for (const prefix of this.titlePrefixes.get(session.id) ?? []) {
      if (title.startsWith(`${prefix} `)) return title.slice(prefix.length+1);
    }
    return title;
  }
  private async projectTopicTitle(session: TopicSession, title: string, active: () => boolean): Promise<void> {
    if (!active()) return;
    try {
      const status = await this.options.runtime.topicTitleStatus(session);
      if (!active()) return;
      const statusText = `${status.worktree ? 'wt:' : ''}${status.branch ?? ''}`;
      const prefixLimit = 127-Math.min(Array.from(title).length,64);
      const statusCharacters = Array.from(statusText);
      const prefix = statusCharacters.length > prefixLimit
        ? `${statusCharacters.slice(0,prefixLimit-1).join('')}…` : statusText;
      let prefixes = this.titlePrefixes.get(session.id);
      if (!prefixes) this.titlePrefixes.set(session.id,prefixes = new Set());
      if (!this.humanTitles.has(session.id) && prefix && title.startsWith(`${prefix} `)) title = title.slice(prefix.length+1);
      this.humanTitles.set(session.id,title);
      const name = Array.from(`${prefix ? `${prefix} ` : ''}${title}`).slice(0,128).join('');
      if (!name.trim()) return;
      if (this.options.store.getSession(session.id)?.name === name) {
        this.options.store.setTopicTitlePrefix(session.id,prefix);
        if (prefix) prefixes.add(prefix);
        return;
      }
      const applied = await this.delivery.run(session.chatId,
        () => this.bot.api.editForumTopic(session.chatId,session.threadId,{name}).catch(error => {
          if (error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED')) return true;
          throw error;
        }),active);
      if (applied && active()) {
        this.options.store.updateSession(session.id,{name});
        this.options.store.setTopicTitlePrefix(session.id,prefix);
        if (prefix) prefixes.add(prefix);
      }
    } catch (error) {
      this.sessionObservation(session.id).failure = {operation:'Topic title synchronization',at:Date.now(),error};
    }
  }
  private syncTopicTitle(session: TopicSession, listener: Listener, title?: string): void {
    if (title !== undefined) listener.sessionTitle = title;
    else title = listener.sessionTitle;
    const generation = this.options.store.getSessionGeneration(session.id);
    const revision = this.titleRevisions.get(session.id);
    const version = listener.titleVersion = (listener.titleVersion ?? 0)+1;
    const active = () => !this.stopped && !refreshTermination(this.options.config) &&
      this.sessionAssigned(session) && this.listeners.get(session.id) === listener &&
      this.options.store.getSession(session.id)?.status === 'open' &&
      this.options.store.getSessionGeneration(session.id) === generation &&
      this.titleRevisions.get(session.id) === revision && listener.titleVersion === version;
    listener.titleTail = (listener.titleTail ?? Promise.resolve()).then(async () => {
      if (!active()) return;
      const pending = this.options.store.getPendingSessionTitle(session.id);
      if (pending !== undefined) {
        if (pending === title) this.options.store.setPendingSessionTitle(session.id,undefined);
        else await this.applySessionTitle(session);
      }
      if (!active()) return;
      const human = this.options.store.getPendingSessionTitle(session.id) ??
        (pending === undefined ? title : undefined) ?? this.humanTitles.get(session.id) ??
        this.stripTopicStatus(session,this.options.store.getSession(session.id)?.name ?? session.name);
      if (pending !== undefined || title !== undefined) this.humanTitles.set(session.id,human);
      await this.projectTopicTitle(session,human,active);
    }).catch(error => {
      this.sessionObservation(session.id).failure = {operation:'Topic title synchronization',at:Date.now(),error};
    });
  }
  private onFrame(session: TopicSession, listener: Listener, frame: HostFrame, replay = false): void {
    if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener) return;
    this.options.runtime.observeFrame(session.id,frame);
    if (frame.t === 'welcome' || (frame.t === 'state' &&
        (!frame.state.isStreaming || (frame.state.sessionName !== undefined &&
          frame.state.sessionName !== this.humanTitles.get(session.id))))) {
      this.syncTopicTitle(session,listener,frame.state.sessionName);
    }
    if (frame.t === 'event' && frame.event.type === 'notice' && frame.event.level === 'error') {
      this.sessionObservation(session.id).failure = {operation:'OMP notice',at:Date.now(),error:frame.event.message};
    }
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
      listener.activity = 'finished';
      void this.setTopicStatus(session, listener.activity);
      void sendTo(this.bot.api, topicDestination(session.chatId, session.threadId), `⛔️${interruptedBy} interrupted the chat`, {
        
      }).catch(() => undefined);
    }
    if (frame.t === 'welcome' || frame.t === 'state') {
      listener.queuedMessages = frame.state.queuedMessageCount;
      listener.activity = this.options.store.hasPendingInitialTask(session.id) || frame.state.isStreaming || listener.queuedMessages > 0 ? 'running' : 'finished';
      void this.setTopicStatus(session, listener.activity);
    } else if (frame.t === 'event' && frame.event.type === 'agent_start') {
      listener.activity = 'running';
      void this.setTopicStatus(session, listener.activity);
    } else if (frame.t === 'event' && frame.event.type === 'agent_end') {
      listener.activity = listener.queuedMessages > 0 ? 'running' : 'finished';
      void this.setTopicStatus(session, listener.activity);
    }
    if (frame.t === 'error') {
      const pending = listener.pendingPrompts.shift();
      if (pending) pending.observation.state = 'not accepted';
      this.sessionObservation(session.id).failure = {operation:'OMP instruction',at:Date.now(),error:frame.message};
      if (isStartupRejection(frame)) pending?.onStartupRejected?.();
    }
    if (isStartupRejection(frame) && listener.initial) {
      const initial = listener.initial;
      initial.phase = 'retrying';
      clearTimeout(initial.timer);
      const delay = Math.min(1000,250 * ++initial.retries);
      if (Date.now()+delay >= initial.deadline) {
        listener.initial = undefined;
        void sendTo(this.bot.api, topicDestination(session.chatId, session.threadId),`The host is still starting. The initial task was not admitted; send your task again after startup. ${this.promptHelp(session.chatId)}`).catch(() => undefined);
      } else {
        initial.timer = setTimeout(() => {
          void this.authorizeInitial(session,initial.userId,initial.authorityUserId).then(() => {
            if (listener.initial !== initial || this.stopped || !this.sessionAssigned(session) || !listener.connection) return;
            if (Date.now() >= initial.deadline) {
              listener.initial = undefined;
              return;
            }
            initial.timer = setTimeout(() => { listener.initial = undefined; },initial.deadline-Date.now());
            initial.timer.unref();
            initial.phase = 'sent';
            this.sendPrompt(listener,initial.text,initial.messageId,initial.images);
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
          pending!.observation.state = 'accepted; completion unknown';
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
        : 'OMP rejected an instruction. OPEN AGENT for details before resending.';
      void sendTo(this.bot.api, topicDestination(session.chatId, session.threadId), text).catch(() => undefined);
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
          () => this.bot.api.sendRichMessage(session.chatId, {markdown:text},{
            message_thread_id: session.threadId === 1 ? undefined : session.threadId,
            ...(replyTarget === undefined ? {} : {reply_parameters:{message_id:replyTarget,allow_sending_without_reply:true}}),
          }), () => !this.stopped && this.sessionAssigned(current) && this.listeners.get(session.id) === listener);
      }
    }).catch(() => undefined).finally(() => { listener.queued--; });
  }
}
export function createBot(options: BotOptions): BotService { return new BotService(options); }
