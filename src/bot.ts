import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { Bot, GrammyError, HttpError, type Context } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { AbortSignal as TelegramAbortSignal } from 'abort-controller';
import { COLLAB_PROMPT_MESSAGE_TYPE, type ImageContent, type CollabUiRequest, type HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, BotConfig, TopicSession, HostBinding, CollabConnection, PromptContent } from '../shared/contracts.js';
import { Store, type PendingSkillKey } from './store.js';
import { AuthorizationUnavailableError, isActiveMember, isAdministrator } from './auth.js';
import { connectCollab, isStartupRejection, readCollabState } from './collab.js';
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
import { classifyMessage, normalizeMessage, type InputIntent, type TelegramImage } from './telegram-input.js';
import { transitionTopicField, topicGoal, type TopicFieldState } from './topic-projection.js';

class AuthorizationDeniedError extends Error {}

export interface RuntimeLike {
  worktree(session: TopicSession, branch?: string): Promise<string>;
  topicTitleStatus(session: TopicSession): Promise<{worktree: boolean; branch?: string}>;
  ensure(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
  /** Resolves an existing host without preparing one; undefined means confirmed absence. */
  resolveExisting(session: TopicSession): Promise<HostBinding | undefined>;
  isRunning(session: TopicSession): Promise<boolean>;
  setSessionTitle(session: TopicSession, title: string): Promise<void>;
  attach(instanceId: string, instancePath: string): Promise<HostBinding>;
  stop(session: TopicSession): Promise<boolean>;
  kill(session: TopicSession): Promise<void>;
  modelPresets(session: TopicSession, name?: string): Promise<string>;
  availableModelPresets(instancePath: string): Promise<string[]>;
  providerUsage(instancePath: string): Promise<{ heading: string; table: string }[]>;
  listSkills(instancePath: string, session?: TopicSession, signal?: AbortSignal): Promise<{name: string; description: string}[]>;
  getSessionLimit(): number;
  setSessionLimit(limit: number): void;
  increaseSessionLimit(expectedLimit: number): boolean;
  observeFrame(sessionId: string, frame: HostFrame): void;
  markPrompt(sessionId: string): void;
  retain(sessionId: string): () => void;
  close(): Promise<void>;
}
export interface BotOptions { config: AppConfig; botConfig: BotConfig; token: string; store: Store; runtime: RuntimeLike; connect?: typeof connectCollab; readState?: typeof readCollabState; bot?: Bot<Context>; configWritable?: () => boolean }
type TopicActivity = 'unknown' | 'running' | 'finished';
type KnownTopicActivity = Exclude<TopicActivity, 'unknown'>;
interface TopicProjection {
  activity: TopicActivity;
  generation: number;
  activityObservedAt?: number;
  revision: number;
  name: TopicFieldState;
  icon: TopicFieldState;
  lifetime: number;
  completion: Record<'name' | 'icon', Promise<void>>;
  currentPrefix: string;
  titleRevision: number;
  humanTitle?: string;
  prefixes: Set<string>;
}
interface StatusFailure { operation: string; at: number; error: unknown }
interface TaskObservation { state: 'waiting for acceptance' | 'not accepted' | 'acceptance unknown' | 'accepted; completion unknown' }
interface SessionObservation { task?: TaskObservation; failure?: StatusFailure; mirrored?: boolean }
interface Listener {
  sessionId: string;
  generation: number;
  frameRevision: number;
  activityRevision: number;
  connection?: CollabConnection;
  promise?: Promise<CollabConnection>;
  tail: Promise<void>;
  sessionTitle?: string;
  queued: number;
  recovering: boolean;
  pendingPrompts: { content: PromptContent; messageId?: number; onStartupRejected?: () => void; observation: TaskObservation }[];
  pendingAnswers: Map<number, number>;
  pendingStops: number[];
  queuedMessages: number;
  activity: TopicActivity;
  activityObservedAt?: number;
  activitySuspect?: boolean;
  activityProbe?: Promise<void>;
  activityProbeController?: AbortController;
  initial?: {
    content: PromptContent;
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
  content: PromptContent;
  instancePath: string;
  sessionId?: string;
  worktree?: boolean;
  generation?: number;
  allMessagesArePrompts: boolean;
  messageId: number;
  expires: number;
}
type SettingsPage = 'root' | 'prompts' | 'proposals' | 'skills' | 'presets' | 'capacity' | 'worktrees';
type SettingsAction = { kind: 'page'; page: SettingsPage; offset?: number }
  | { kind: 'set'; field: 'all_messages_are_prompts' | 'users_can_propose_prompts' | 'create_topic_worktrees'; value: boolean }
  | { kind: 'default'; field: 'default_new_topic_skill' | 'default_model_preset'; value?: string }
  | { kind: 'propose-capacity'; limit: number; target: number }
  | { kind: 'capacity'; limit: number; target: number }
  | { kind: 'close' };
interface SettingsPanel {
  token: string;
  chatId: number;
  destination: TopicDestination;
  messageId: number;
  instancePath: string;
  revision: number;
  offset: number;
  choices: SettingsAction[];
  changes: Map<SettingsPage, {label: string; before: string; after: string}>;
}
const help = '/setup — request or enroll this forum, then open settings\n/settings — forum defaults and live session count limit (group admin)\n/new task — new topic and session\n/worktree [branch] — move this session into an OMP worktree; General creates a topic first\n/attach instanceId [name] — attach local host (group admin)\n/detach — make this topic conversation-only (group admin)\n/model_preset [name] — list presets, or switch this idle session by name (group admin)\n/session — open this session\n/status — host, mirroring, task admission, recovery and skill diagnostics\n/usage — provider plan usage, remaining quotas and resets\n/stop — interrupt the current turn (session topic only)\n/kill — force-kill the host process (session topic only)\n/terminate — terminate all agents and suspend the service (group admin)';
const settingsHelp = '/settings — forum defaults and live session count limit (group admin)';
const adminHelp = '/list_admins — list current human group owner and administrators. Manage administrator roles in Telegram.';
const cliCommand = {command:'cli',description:'Copy a local terminal session join command (group admin)'};
const cliHelp = '/cli — copy a local terminal session join command (group admin)';
const terminationMessage = 'The service got terminated, only admin can resume it (remove terminated: true from the config)';
const groupCommands = [
  { command: 'new', description: 'Start a new session' },
  { command: 'worktree', description: 'Move session to an OMP worktree; new topic in General' },
  { command: 'p', description: 'New session in General; prompt in explicit-command topics' },
  { command: 'skills', description: 'Select or clear skills for your next prompt' },
  { command: 'settings', description: 'Forum defaults and live session count limit (group admin)' },
  { command: 'setup', description: 'Request or enroll this forum, then open settings' },
  { command: 'list_admins', description: 'List current human group owner and administrators' },
  { command: 'attach', description: 'Attach a local OMP host (group admin)' },
  { command: 'detach', description: 'Make this topic conversation-only (group admin)' },
  { command: 'session', description: 'Open this topic’s session' },
  { command: 'status', description: 'Show host, mirroring, recovery and skill diagnostics' },
  { command: 'usage', description: 'Show provider plan usage, remaining quotas and resets' },
  { command: 'stop', description: 'Interrupt the current turn in this session topic' },
  { command: 'kill', description: 'Force-kill this session’s host; preserve history' },
  { command: 'terminate', description: 'Terminate all agents and suspend service (group admin)' },
  { command: 'model_preset', description: 'List presets; /model_preset <name> switches an idle session' },
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
  readonly bot: Bot<Context>;
  readonly config: BotConfig;
  readonly token: string;
  private readonly listeners = new Map<string, Listener>();
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  private readonly capacityRequests = new Map<string, CapacityRequest>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly endedQuestionReplies = new Set<string>();
  private readonly delivery: TelegramDelivery;
  private readonly topicProjections = new Map<string, TopicProjection>();
  private readonly hostObservations = new Map<string, Promise<void>>();
  private readonly mirrorRecoveries = new Map<string,Promise<void>>();
  private readonly hostTitleWrites = new Map<string,Promise<void>>();
  private topicTicket = 0;
  private readonly sessionInvalidationHandlers = new Set<(sessionId: string, reason?: string) => void>();
  private readonly closedSessions = new Map<string, { generation: number; settled: boolean; pending?: Promise<void> }>();
  private readonly commandMenus = new Map<number, string>();
  private globalCommandMenu?: string;
  private readonly skillAliases = new Map<number, Map<string, SkillCatalogEntry>>();
  private menuTimer?: NodeJS.Timeout;
  private readonly background = new AbortController();
  private catalogRefresh = new AbortController();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly catalogTasks = new Map<string, Promise<void>>();
  private readonly presetCatalogs = new Map<string, string[]>();
  private presetRefresh?: Promise<void>;
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
  private readonly inputIntents = new WeakMap<Context, InputIntent>();
  private readonly albums = new Map<string, {contexts:Context[];ready:Promise<void>;resolve:()=>void;timer?:NodeJS.Timeout}>();
  private readonly albumPrompts = new WeakMap<Context, {contexts:Context[]}>();
  private saveSettingsPanel(panel: SettingsPanel): void {
    this.options.store.db.prepare('INSERT INTO settings_panels VALUES (?,?,?) ON CONFLICT(bot_id,token) DO UPDATE SET panel=excluded.panel')
      .run(this.id, panel.token, JSON.stringify({...panel, changes: [...panel.changes]}));
  }
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
      revision: 0, offset: 0, choices: [], changes: new Map(),
    };
    const persisted = await this.settingsAccess(ctx, panel);
    const message = await replyTo(ctx, panel.destination, 'Opening settings…');
    panel.messageId = message.message_id;
    await this.renderSettings(panel, persisted);
  }
  private async renderSettings(panel: SettingsPanel, config: AppConfig, page: SettingsPage = 'root', offset = 0, proposal?: {limit: number; target: number}): Promise<void> {
    const assigned = findInstance(config, this.id, panel.chatId)!;
    const chat = assigned.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)!;
    const rows: {text: string; callback_data: string}[][] = [];
    const choices: SettingsAction[] = [];
    const revision = panel.revision + 1;
    const button = (text: string, action: SettingsAction, current = false) => {
      const index = choices.push(action) - 1;
      rows.push([{text: current ? `${text.slice(0, 90)} (current)` : text.slice(0, 100), callback_data: `settings:${panel.token}:${revision}:${index}`}]);
    };
    let text = 'Settings\nApplies to this group unless marked service-wide.';
    if (page === 'root') {
      for (const [label, target] of [
        [`Message handling · ${chat.all_messages_are_prompts === false ? 'Commands and replies only' : 'All messages'}`, 'prompts'],
        [`Who can send requests · ${chat.users_can_propose_prompts === true ? 'Members with admin approval' : 'Admins only'}`, 'proposals'],
        [`Skill for new topics · ${chat.default_new_topic_skill ?? 'No default skill'}`, 'skills'],
        [`Model preset for new sessions · ${chat.default_model_preset ?? 'Use host default'}`, 'presets'],
        [`Maximum live sessions · ${config.omp.maxSessions} · Service-wide`, 'capacity'],
        [`Worktrees for new topics · ${chat.create_topic_worktrees === true ? 'Create a worktree' : 'Use the instance directory'}`, 'worktrees'],
      ] as const) {
        button(label, {kind:'page',page:target});
      }
    } else if (page === 'prompts') {
      text = 'Which messages go to the assistant?\nApplies to this group.\nCommands and replies only means using /p or replying to a bot message. Ordinary messages and mentions are ignored.';
      button('All messages', {kind:'set',field:'all_messages_are_prompts',value:true}, chat.all_messages_are_prompts !== false);
      button('Commands and replies only', {kind:'set',field:'all_messages_are_prompts',value:false}, chat.all_messages_are_prompts === false);
    } else if (page === 'proposals') {
      text = 'Who can send requests?\nApplies to this group.\nAdmin requests run directly. Member requests need admin approval.';
      button('Members too, with admin approval', {kind:'set',field:'users_can_propose_prompts',value:true}, chat.users_can_propose_prompts === true);
      button('Admins only', {kind:'set',field:'users_can_propose_prompts',value:false}, chat.users_can_propose_prompts !== true);
    } else if (page === 'worktrees') {
      text = 'Give each new topic its own worktree?\nApplies to new managed topics in this group. Existing topics are unchanged.\nA worktree gives the topic a separate working directory and branch.';
      button('Create a worktree', {kind:'set',field:'create_topic_worktrees',value:true}, chat.create_topic_worktrees === true);
      button('Use the instance directory', {kind:'set',field:'create_topic_worktrees',value:false}, chat.create_topic_worktrees !== true);
    } else if (page === 'skills' || page === 'presets') {
      const skill = page === 'skills';
      const names = skill ? (await this.options.runtime.listSkills(panel.instancePath)).map(entry => entry.name).filter(isMentionableSkillName) : await this.options.runtime.availableModelPresets(panel.instancePath);
      if (this.assignedPath(panel.chatId) !== panel.instancePath) throw new Error('The group instance assignment changed');
      const field = skill ? 'default_new_topic_skill' : 'default_model_preset';
      text = `${skill ? 'Skill for new topics' : 'Model preset for new sessions'}\nApplies to this group.\nCurrent choice: ${chat[field] ?? (skill ? 'No default skill' : 'Use host default')}\n${names.length ? `Choices ${offset + 1}–${Math.min(offset + 8, names.length)} of ${names.length}.` : 'No named choices available.'}\n${skill ? 'New topics use this skill. Existing topics are unchanged.' : 'The preset applies when a managed host next starts. Running hosts are unchanged.'}`;
      for (const name of names.slice(offset, offset + 8)) button(name, {kind:'default',field,value:name}, chat[field] === name);
      button(skill ? 'No default skill' : 'Use host default', {kind:'default',field}, chat[field] === undefined);
      if (offset > 0) button('Previous', {kind:'page',page,offset:Math.max(0,offset-8)});
      if (offset + 8 < names.length) button('Next', {kind:'page',page,offset:offset+8});
    } else {
      const limit = this.options.runtime.getSessionLimit();
      if (proposal) {
        text = `Maximum live sessions: ${proposal.limit} → ${proposal.target}?\nService-wide.`;
        button(`Set limit to ${proposal.target}`, {kind:'capacity',limit:proposal.limit,target:proposal.target});
      } else {
        text = `Maximum live sessions: ${limit}\nService-wide.`;
        for (const [label,target] of [['−',limit-1],['+',limit+1]] as const) {
          button(label, Number.isSafeInteger(target) && target >= 1 && target !== limit
            ? {kind:'propose-capacity',limit,target}
            : {kind:'page',page:'capacity'});
        }
        rows.splice(0, 2, [...rows[0]!, ...rows[1]!]);
      }
    }
    if (page !== 'root') button(proposal ? 'Cancel' : 'Back to settings', {kind:'page',page:proposal ? 'capacity' : 'root'});
    button('Close', {kind:'close'});
    await this.bot.api.editMessageText(panel.chatId, panel.messageId, text.startsWith('Settings\n') ? text : `Settings\n${text}`, {reply_markup:{inline_keyboard:rows}});
    panel.choices = choices;
    panel.revision = revision;
    panel.offset = offset;
    this.saveSettingsPanel(panel);
  }
  private async settingsCallback(ctx: Context, data: string): Promise<void> {
    const match = data.match(/^settings:([A-Za-z0-9_-]{22}):(\d+):(\d+)$/);
    const stored = match ? this.options.store.db.prepare('SELECT panel FROM settings_panels WHERE bot_id=? AND token=?').get(this.id, match[1]!) : undefined;
    const decoded = stored ? JSON.parse(String(stored.panel)) as Omit<SettingsPanel, 'changes'> & {changes: [SettingsPage, {label: string; before: string; after: string}][]} : undefined;
    const panel: SettingsPanel | undefined = decoded ? {...decoded, changes: new Map(decoded.changes)} : undefined;
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!match || !message || !ctx.chat || ctx.chat.type !== 'supergroup' ||
        !('from' in message) || message.from?.id !== this.id || 'forward_origin' in message || 'forward_date' in message) return;
    if (!panel) {
      const recovered: SettingsPanel = {
        token: match[1]!, chatId: ctx.chat.id, destination: contextDestination(ctx),
        messageId: message.message_id, instancePath: this.assignedPath(ctx.chat.id),
        revision: Number(match[2]), offset: 0, choices: [], changes: new Map(),
      };
      const config = await this.settingsAccess(ctx, recovered);
      await this.renderSettings(recovered, config);
      await ctx.answerCallbackQuery();
      return;
    }
    if (ctx.chat.id !== panel.chatId || message.message_id !== panel.messageId ||
        !sameTopicDestination(contextDestination(ctx), panel.destination)) return;
    if (Number(match[2]) !== panel.revision) {
      const config = await this.settingsAccess(ctx, panel);
      await this.renderSettings(panel, config);
      await ctx.answerCallbackQuery();
      return;
    }
    const action = panel.choices[Number(match![3])];
    if (!action) return;
    const config = await this.settingsAccess(ctx, panel, action.kind === 'set' || action.kind === 'default' || action.kind === 'capacity');
    const recordChange = (page: SettingsPage, label: string, before: string, after: string) => {
      const original = panel.changes.get(page)?.before ?? before;
      if (original === after) panel.changes.delete(page);
      else panel.changes.set(page, {label, before: original, after});
    };
    if (action.kind === 'close') {
      const changes = [...panel.changes.values()].map(({label,before,after}) => `${label}: ${before.slice(0, 200)} → ${after.slice(0, 200)}`);
      const summary = changes.length ? `Settings closed.\n\nSaved changes\n${changes.join('\n')}` : 'Settings closed.\nNo settings changed.';
      await this.bot.api.editMessageText(panel.chatId,panel.messageId,summary,{reply_markup:{inline_keyboard:[]}});
      panel.choices = [];
      this.saveSettingsPanel(panel);
      return;
    }
    if (action.kind === 'page') { await this.renderSettings(panel,config,action.page,action.offset); return; }
    if (action.kind === 'propose-capacity') {
      if (this.options.runtime.getSessionLimit() !== action.limit || config.omp.maxSessions !== action.limit) throw new Error('The live session count limit changed. Open Live session count limit again.');
      if (!Number.isSafeInteger(action.target) || action.target < 1) throw new Error('The live session count limit must be a positive safe integer.');
      await this.renderSettings(panel,config,'capacity',0,action);
      return;
    }
    if (action.kind === 'capacity') {
      if (!Number.isSafeInteger(action.target) || action.target < 1) throw new Error('The live session count limit must be a positive safe integer.');
      if (this.options.runtime.getSessionLimit() !== action.limit || config.omp.maxSessions !== action.limit) throw new Error('The live session count limit changed. Open Live session count limit again.');
      config.omp.maxSessions = action.target;
      writeConfig(config);
      this.options.config.omp.maxSessions = action.target;
      this.options.runtime.setSessionLimit(action.target);
      recordChange('capacity', 'Maximum live sessions (service-wide)', String(action.limit), String(action.target));
      this.saveSettingsPanel(panel);
    } else {
      if (action.kind === 'default' && action.value !== undefined) {
        const names = action.field === 'default_new_topic_skill'
          ? (await this.options.runtime.listSkills(panel.instancePath)).map(entry => entry.name)
          : await this.options.runtime.availableModelPresets(panel.instancePath);
        if (!names.includes(action.value)) throw new Error(`Unknown ${action.field === 'default_new_topic_skill' ? 'skill' : 'model preset'}: ${action.value}`);
      }
      const current = await this.settingsAccess(ctx,panel,true);
      const chat = findInstance(current,this.id,panel.chatId)!.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)!;
      const page: SettingsPage = action.kind === 'default'
        ? action.field === 'default_new_topic_skill' ? 'skills' : 'presets'
        : action.field === 'all_messages_are_prompts' ? 'prompts'
        : action.field === 'users_can_propose_prompts' ? 'proposals' : 'worktrees';
      const labels = {
        prompts: 'Message handling',
        proposals: 'Who can send requests',
        skills: 'Skill for new topics',
        presets: 'Model preset for new sessions',
        worktrees: 'Worktrees for new topics',
      };
      const value = (setting: boolean | string | undefined): string => {
        if (action.kind === 'default') return setting === undefined ? page === 'skills' ? 'No default skill' : 'Use host default' : String(setting);
        if (page === 'prompts') return setting === false ? 'Commands and replies only' : 'All messages';
        if (page === 'proposals') return setting === true ? 'Members with admin approval' : 'Admins only';
        return setting === true ? 'Create a worktree' : 'Use the instance directory';
      };
      const before = value(chat[action.field]);
      if (action.kind === 'set') chat[action.field] = action.value;
      else if (action.value === undefined) delete chat[action.field];
      else chat[action.field] = action.value;
      writeConfig(current);
      recordChange(page, labels[page], before, value(chat[action.field]));
      this.saveSettingsPanel(panel);
      Object.assign(findInstance(this.options.config,this.id,panel.chatId)!.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)!,chat);
      if (action.kind === 'default' && action.value === undefined) delete findInstance(this.options.config,this.id,panel.chatId)!.instance.chats.find(chat => chat.botId === this.id && chat.chatId === panel.chatId)![action.field];
      await this.syncCommandMenus();
      const offset = action.kind === 'default' ? panel.offset : 0;
      await this.renderSettings(panel,current,page,offset);
      return;
    }
    await this.renderSettings(panel,config,'capacity');
  }
  private readonly skills: SkillPicker;
  private iconIds?: Promise<Record<KnownTopicActivity, string>>;
  private statusTimer?: NodeJS.Timeout;
  private checkingStatuses = false;
  private updateTail: Promise<void> = Promise.resolve();
  private queuedUpdates = 0;
  private stopped = false;
  private polling?: { controller: TelegramAbortController; done: Promise<void> };
  constructor(private readonly options: BotOptions) {
    this.bot = options.bot ?? new Bot(options.token);
    this.delivery = new TelegramDelivery();
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
      if (this.collectAlbum(ctx)) return;
      const intent = this.classifyInput(ctx);
      const urgent = intent.kind === 'command' && intent.action === 'terminate';
      if (++this.queuedUpdates > 256 && !urgent) { this.queuedUpdates--; return; }
      const received = this.receiveMessage(ctx,intent);
      const process = async () => { await received; await this.handle(ctx, intent); };
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
    const intent = this.inputIntents.get(ctx);
    if (ctx.chat && ctx.message && !(intent?.kind === 'command' && intent.action === 'status')) {
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
        this.albumPrompts.set(source,{contexts:pending.contexts});
        const intent = this.classifyInput(source);
        await this.receiveMessage(source,intent);
        await this.handle(source,intent);
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
    const reply = message.reply_to_message;
    const question = reply?.from?.id === this.id ? [...this.questions.entries()].find(([,pending]) =>
      pending.session.chatId === ctx.chat!.id && pending.session.threadId === message.message_thread_id &&
      pending.messageIds.includes(reply.message_id)) : undefined;
    const messages = (this.albumPrompts.get(ctx)?.contexts ?? [ctx]).flatMap(part => part.message ? [part.message] : []);
    const intent = classifyMessage(message,normalizeMessage(messages),{
      botId:this.id,username:this.bot.botInfo!.username,
      allMessagesArePrompts:this.allMessagesArePrompts(ctx.chat.id),
      commands:new Set([...groupCommands.map(command => command.command),'cli']),
      skillAliases:this.skillAliases.get(ctx.chat.id) ?? new Map(),
      question:question?.[0],
      endedQuestion:Boolean(reply?.from?.id === this.id && this.endedQuestionReplies.has(`${ctx.chat.id}:${reply.message_id}`)),
    });
    this.inputIntents.set(ctx,intent);
    return intent;
  }
  private async receiveMessage(ctx: Context, intent: InputIntent): Promise<void> {
    if (intent.kind === 'ignore' || intent.kind === 'event' || intent.kind === 'ended-question') return;
    const message = ctx.message;
    if (this.options.config.terminated || this.stopped || !message || !ctx.chat || ctx.chat.type !== 'supergroup') return;
    const assigned = findInstance(this.options.config,this.id,ctx.chat.id);
    if (!assigned || !this.options.store.isEnrolled(this.id,ctx.chat.id)) return;
    const topic = this.options.store.getTopic({botId:this.id,destination:contextDestination(ctx)});
    if (topic && topic.status !== 'open') return;
    if ((intent.kind === 'new-task' || intent.kind === 'session-prompt') &&
        !this.usersCanProposePrompts(ctx.chat.id) && !(await this.currentAdmin(ctx))) return;
    await this.delivery.run(ctx.chat.id,
      () => this.bot.api.setMessageReaction(ctx.chat!.id,message.message_id,[{type:'emoji',emoji:'👀'}]),
      () => !this.stopped && findInstance(this.options.config,this.id,ctx.chat!.id)?.path === assigned.path).catch(() => undefined);
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
        for (const handler of this.sessionInvalidationHandlers) handler(session.id);
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
    await this.syncCommandMenus();
    await this.syncSessionEntries();
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
          const sessions = this.options.store.listSessions(this.id);
          await Promise.all(Array.from({length:Math.min(4,sessions.length)},async () => {
            for (let next = sessions.shift(); next; next = sessions.shift()) {
              const session = next;
              signal.throwIfAborted();
              if (this.sessionAssigned(session)) {
                if (this.options.store.hasPendingInitialTask(session.id)) {
                  void this.runBackground(`initial-recovery:${session.id}`,() => this.sendInitial(session));
                }
                await Promise.all([
                  this.runBackground(`topic-status:${session.id}`,() => this.refreshTopicStatus(session)),
                  this.runBackground(`mirror-recovery:${session.id}`,() => this.recoverExistingMirror(session)),
                ]);
              } else this.dropListener(session.id);
            }
          }));
        } finally { this.checkingStatuses = false; }
      });
    }, 30000);
    this.statusTimer.unref();
    void this.refreshSkillCatalogs();
    void this.refreshPresetCatalogs();
    this.menuTimer ??= setInterval(() => { void this.refreshSkillCatalogs(); void this.refreshPresetCatalogs(); }, 60000);
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
    const sessions = this.options.store.listSessions(this.id).filter(existing => !this.options.config.terminated &&
      this.sessionAssigned(existing) && !this.listeners.has(existing.id) && !this.restoring.has(existing.id));
    for (const session of sessions) this.restoring.add(session.id);
    void Promise.all(Array.from({length:Math.min(4,sessions.length)},async () => {
      for (let next = sessions.shift(); next; next = sessions.shift()) {
        const existing = next;
        const generation = this.options.store.getSessionGeneration(existing.id);
        await this.runBackground(`restore:${existing.id}`, async signal => {
          try {
            if (existing.status === 'open') {
              if (this.options.store.hasPendingInitialTask(existing.id)) {
                await withCancellation(this.sendInitial(existing),signal);
              } else {
                await this.recoverExistingMirror(existing,signal);
              }
            }
            await withCancellation(this.refreshTopicStatus(existing), signal);
          } catch (error) {
            if (error === signal.reason) throw error;
            if (!this.stopped && !(error instanceof SessionCapacityError) && this.options.store.getSessionGeneration(existing.id) === generation) this.scheduleReconnect(existing);
            throw error;
          }
        }).finally(() => this.restoring.delete(existing.id));
      }
    }));
  }
  private recoverExistingMirror(session: TopicSession, signal = this.background.signal): Promise<void> {
    if (this.stopped || this.options.config.terminated || signal.aborted) return Promise.resolve();
    const existing = this.mirrorRecoveries.get(session.id);
    if (existing) return existing;
    const generation = this.options.store.getSessionGeneration(session.id);
    const owner = this.topicProjection(session);
    const active = () => !this.stopped && !this.options.config.terminated && this.sessionAssigned(session) &&
      this.options.store.getSession(session.id)?.status === 'open' &&
      this.options.store.getSessionGeneration(session.id) === generation && this.topicProjections.get(session.id) === owner;
    if (!active() || this.listeners.has(session.id) || this.options.store.hasPendingInitialTask(session.id)) return Promise.resolve();
    const deadline = AbortSignal.any([signal,AbortSignal.timeout(5000)]);
    const recovery = (async () => {
      const binding = await withCancellation(this.options.runtime.resolveExisting(session),deadline);
      if (!binding || !active() || this.listeners.has(session.id)) return;
      const connecting = this.listen(session,binding,undefined,true);
      const listener = this.listeners.get(session.id);
      try {
        await withCancellation(connecting,deadline);
      } catch (error) {
        if (this.listeners.get(session.id) === listener) this.dropListener(session.id);
        throw error;
      }
    })().finally(() => {
      if (this.mirrorRecoveries.get(session.id) === recovery) this.mirrorRecoveries.delete(session.id);
    });
    this.mirrorRecoveries.set(session.id,recovery);
    return recovery;
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
  private refreshPresetCatalogs(): Promise<void> {
    if (this.stopped || this.options.config.terminated) return Promise.resolve();
    if (this.presetRefresh) return this.presetRefresh;
    const signal = this.catalogRefresh.signal;
    const tasks = Object.entries(this.options.config.instances)
      .filter(([, instance]) => instance.chats.some(chat => chat.botId === this.id))
      .map(([instancePath]) => this.runBackground(`presets:${instancePath}`, async () => {
        const names = await withCancellation(this.options.runtime.availableModelPresets(instancePath), signal);
        signal.throwIfAborted();
        if (!this.options.config.instances[instancePath]?.chats.some(chat => chat.botId === this.id)) return;
        this.presetCatalogs.set(instancePath, names);
        await this.syncCommandMenus();
      }, signal));
    const task = Promise.all(tasks).then(() => {});
    this.presetRefresh = task;
    void task.finally(() => { if (this.presetRefresh === task) this.presetRefresh = undefined; });
    return task;
  }
  private presetDescription(instancePath: string): string {
    let description = groupCommands.find(command => command.command === 'model_preset')!.description;
    const names = [...(this.presetCatalogs.get(instancePath) ?? [])].sort((a, b) => a.length - b.length || a.localeCompare(b));
    let separator = '. Presets: ';
    for (const name of names) {
      if (description.length + separator.length + name.length > 256) break;
      description += separator + name;
      separator = ', ';
    }
    return description;
  }
  private async replyPresetUsage(ctx: Context, instancePath: string, guidance = ''): Promise<void> {
    const names = await this.options.runtime.availableModelPresets(instancePath);
    await this.replyPresetText(ctx, `Usage: /model_preset to list presets, or /model_preset <name> to switch an idle session.\nAvailable presets:\n${names.length ? names.join('\n') : '(none configured)'}${guidance}`);
  }
  private async replyPresetText(ctx: Context, text: string): Promise<void> {
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset+4000,text.length);
      if (end < text.length && text.charCodeAt(end-1) >= 0xD800 && text.charCodeAt(end-1) <= 0xDBFF) end--;
      await replyTo(ctx, contextDestination(ctx), text.slice(offset,end));
      offset = end;
    }
  }
  onSessionInvalidated(handler: (sessionId: string, reason?: string) => void): () => void {
    this.sessionInvalidationHandlers.add(handler);
    return () => { this.sessionInvalidationHandlers.delete(handler); };
  }
  reopenSession(session: TopicSession, userId: number, beforeMutation: () => void, signal?: AbortSignal): Promise<TopicSession> {
    const operation = this.updateTail.then(async () => {
      if (!(await this.authorizeSession(session,userId,signal))) throw new Error('Administrator access required to reopen this topic');
      signal?.throwIfAborted();
      beforeMutation();
      this.requireSessionAssignment(session);
      const current = this.options.store.getSession(session.id)!;
      if (current.status === 'detached') throw new Error('This topic is conversation-only; its session is detached');
      if (current.status === 'closed') {
        const deadline = new AbortController();
        const timeoutReason = new DOMException('Telegram topic reopening timed out after 10 seconds','TimeoutError');
        const cancellation = AbortSignal.any(signal ? [signal,this.background.signal,deadline.signal] : [this.background.signal,deadline.signal]);
        const telegram = new TelegramAbortController();
        const cancelTelegram = () => telegram.abort();
        cancellation.addEventListener('abort',cancelTelegram,{once:true});
        const timeout = setTimeout(() => deadline.abort(timeoutReason),10000);
        try {
          cancellation.throwIfAborted();
          await withCancellation(this.bot.api.reopenForumTopic(current.chatId,current.threadId,telegram.signal),cancellation);
        } finally {
          clearTimeout(timeout);
          cancellation.removeEventListener('abort',cancelTelegram);
          telegram.abort();
        }
        beforeMutation();
        this.requireSessionAssignment(current);
        this.options.store.updateSession(current.id,{status:'open'});
        this.closedSessions.delete(current.id);
      }
      return this.options.store.getSession(session.id)!;
    });
    this.updateTail = operation.then(() => undefined,() => undefined);
    return operation;
  }
  async ensureMirroring(session: TopicSession, binding: HostBinding, beforeMutation?: () => Promise<void>): Promise<void> {
    this.requireSessionAssignment(session);
    await this.listen(session,binding,beforeMutation);
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
    for (const id of this.topicProjections.keys()) this.invalidateTopicStatus(id);
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
    this.closedSessions.clear();
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
    await Promise.all([...this.topicProjections.values()].flatMap(projection => Object.values(projection.completion)));
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
  async authorizeSession(session: TopicSession, userId: number, signal?: AbortSignal): Promise<boolean> {
    const member = await this.authorizeMember(session.chatId, userId, false, signal);
    signal?.throwIfAborted();
    this.requireSessionAssignment(session);
    return isAdministrator(member);
  }
  private async authorizeMember(chatId: number, userId: number, statusOnly = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.stopped) throw this.background.signal.reason;
    if (refreshTermination(this.options.config) && !statusOnly) throw new Error(terminationMessage);
    const instancePath = this.assignedPath(chatId);
    if (!this.options.store.isEnrolled(this.id, chatId)) throw new Error('Group not enrolled');
    const deadline = new AbortController();
    const timeoutReason = new DOMException('Telegram authorization lookup timed out after 10 seconds', 'TimeoutError');
    const cancellation = AbortSignal.any(signal ? [signal, this.background.signal, deadline.signal] : [this.background.signal, deadline.signal]);
    const telegram = new TelegramAbortController();
    const cancelTelegram = () => telegram.abort();
    cancellation.addEventListener('abort', cancelTelegram, {once:true});
    const timeout = setTimeout(() => deadline.abort(timeoutReason), 10000);
    try {
      cancellation.throwIfAborted();
      const [chat, user, bot] = await withCancellation(Promise.all([
        this.bot.api.getChat(chatId, telegram.signal),
        this.bot.api.getChatMember(chatId, userId, telegram.signal),
        this.bot.api.getChatMember(chatId, this.id, telegram.signal),
      ]), cancellation).catch(error => {
        if (cancellation.aborted && cancellation.reason !== timeoutReason) throw cancellation.reason;
        if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 && error.error_code !== 429) throw error;
        throw new AuthorizationUnavailableError(error);
      });
      cancellation.throwIfAborted();
      if (refreshTermination(this.options.config) && !statusOnly) throw new Error(terminationMessage);
      if (this.assignedPath(chatId) !== instancePath) throw new Error('The group instance assignment changed');
      if (!isActiveMember(user)) throw new AuthorizationDeniedError('Group access denied');
      if (chat.type !== 'supergroup' || (!statusOnly && (!chat.is_forum || bot.status !== 'administrator' || !bot.can_manage_topics))) throw new Error('Group access denied');
      if (this.stopped) throw this.background.signal.reason;
      if (!this.options.store.isEnrolled(this.id, chatId)) throw new Error('Group not enrolled');
      return user;
    } finally {
      clearTimeout(timeout);
      cancellation.removeEventListener('abort', cancelTelegram);
      telegram.abort();
    }
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
  private createsTopicWorktrees(chatId: number): boolean {
    return findInstance(this.options.config, this.id, chatId)?.instance.chats
      .find(chat => chat.botId === this.id && chat.chatId === chatId)?.create_topic_worktrees === true;
  }
  private async createTopicWorktree(session: TopicSession): Promise<void> {
    this.requireSessionAssignment(session);
    await this.options.runtime.worktree(session, `t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`);
    this.options.store.setSessionRuntime(session.id, session.runtime);
  }
  private promptHelp(chatId: number): string {
    const input = this.allMessagesArePrompts(chatId)
      ? 'Text messages in a session topic are treated as prompts.'
      : 'Use /p <prompt> or reply to my messages in a session topic. Ordinary messages and mentions are ignored.';
    return `${input}\nIn General, /p works like /new: include the task in the command or reply to a message with text.\n${this.usersCanProposePrompts(chatId)
      ? 'Non-admin prompts require approval by a group administrator.'
      : 'Only group administrators can send prompts. Other members’ messages are ignored.'}`;
  }
  private commandHelp(): string {
    return this.options.config.publicUrl ? help : help.split('\n').filter(line => !line.startsWith('/session ')).join('\n');
  }
  private syncCommandMenus(): Promise<void> {
    const operation = this.menuTail.then(() => this.publishCommandMenus());
    this.menuTail = operation.catch(() => {});
    return operation;
  }
  private async publishCommandMenus(): Promise<void> {
    const baseCommands = this.options.config.publicUrl ? groupCommands : groupCommands.filter(command => command.command !== 'session');
    const globalFingerprint = JSON.stringify(baseCommands);
    if (this.globalCommandMenu !== globalFingerprint) {
      await this.bot.api.setMyCommands(baseCommands, {scope:{type:'all_group_chats'}}, this.apiAbort.signal);
      this.globalCommandMenu = globalFingerprint;
    }
    const current = new Set<number>();
    for (const [instancePath, instance] of Object.entries(this.options.config.instances)) {
      const chats = instance.chats.filter(chat => chat.botId === this.id);
      if (!chats.length) continue;
      for (const chat of chats) current.add(chat.chatId);
      const skills = this.options.store.getSkillCatalog(instancePath) ?? [];
      if (this.stopped) return;
      const aliases = new Map([...skillCommandAliases(skills)].slice(0, 100 - baseCommands.length));
      const instanceCommands = baseCommands.map(command => command.command === 'model_preset' ? {...command, description:this.presetDescription(instancePath)} : command);
      const commands = [...instanceCommands, ...[...aliases].map(([command, skill]) => ({
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
        await this.bot.api.setMyCommands([...instanceCommands,cliCommand,...commands.slice(instanceCommands.length)].slice(0,100), {scope:{type:'chat_administrators',chat_id:chat.chatId}}, this.apiAbort.signal);
        if (this.stopped || !this.options.config.instances[instancePath]?.chats.some(assigned => assigned.botId === this.id && assigned.chatId === chat.chatId)) continue;
        this.commandMenus.set(chat.chatId, fingerprint);
        this.skillAliases.set(chat.chatId, aliases);
      }
    }
    for (const chatId of this.commandMenus.keys()) {
      if (current.has(chatId)) continue;
      await this.bot.api.deleteMyCommands({scope:{type:'chat',chat_id:chatId}}, this.apiAbort.signal);
      await this.bot.api.deleteMyCommands({scope:{type:'chat_administrators',chat_id:chatId}}, this.apiAbort.signal);
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
    this.presetRefresh = undefined;
    for (const session of this.options.store.listSessions(this.id)) {
      if (!this.sessionAssigned(session)) {
        this.dropListener(session.id);
        this.closedSessions.delete(session.id);
        this.topicProjections.delete(session.id);
        for (const [token, request] of this.capacityRequests) if (request.sessionId === session.id) this.capacityRequests.delete(token);
        for (const handler of this.sessionInvalidationHandlers) handler(session.id);
      }
    }
    if (this.options.config.terminated) { await this.applyTermination(); return; }
    this.termination = undefined;
    await this.syncCommandMenus();
    await this.syncSessionEntries();
    this.restoreSessions();
    void this.refreshSkillCatalogs();
    void this.refreshPresetCatalogs();
  }
  private async syncSessionEntries(): Promise<void> {
    for (const session of this.options.store.listSessions(this.id)) {
      if (!this.sessionAssigned(session)) continue;
      const entry = this.options.store.getSessionEntry(session.id);
      if (!entry) continue;
      const reply_markup = this.sessionMarkup(session);
      const markup = JSON.stringify(reply_markup);
      if (entry.markup === markup) continue;
      try {
        await this.bot.api.editMessageReplyMarkup(session.chatId, entry.messageId, {reply_markup});
      } catch (error) {
        if (!(error instanceof GrammyError)) throw error;
        if (error.description === 'Bad Request: message to edit not found') {
          console.warn(`Pinned session entry no longer exists (${session.id}, ${entry.messageId}).`,error);
          this.options.store.clearSessionEntry(session.id);
          continue;
        }
        if (!error.description.startsWith('Bad Request: message is not modified')) throw error;
        console.warn(`Pinned session entry already has the desired markup (${session.id}, ${entry.messageId}).`,error);
      }
      this.options.store.setSessionEntry(session.id,entry.messageId,markup);
    }
  }
  private sessionMarkup(session: TopicSession) {
    return {inline_keyboard: this.options.config.publicUrl && this.config.miniAppShortName
      ? [[{text:'OPEN AGENT',url:this.link(session)}]] : []};
  }
  private link(session: TopicSession): string {
    return `https://t.me/${this.bot.botInfo!.username}/${this.config.miniAppShortName}?startapp=s_${session.id}`;
  }
  private async getIconIds(): Promise<Record<KnownTopicActivity, string>> {
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
  private invalidateTopicStatus(id: string): void {
    const projection = this.topicProjections.get(id);
    if (!projection) return;
    projection.activity = 'unknown';
    ++projection.revision;
    for (const field of ['name','icon'] as const) {
      projection[field] = transitionTopicField(projection[field],{type:'publish'});
    }
  }
  private topicProjection(session: TopicSession): TopicProjection {
    let projection = this.topicProjections.get(session.id);
    if (!projection) {
      projection = {activity:'unknown',generation:this.options.store.getSessionGeneration(session.id),revision:0,titleRevision:0,prefixes:new Set(),
        name:{kind:'disabled'},icon:{kind:'disabled'},lifetime:10 * 60_000 +
          createHash('sha256').update(session.id).digest().readUInt32BE(0) % 60_000,
        completion:{name:Promise.resolve(),icon:Promise.resolve()},currentPrefix:''};
      this.topicProjections.set(session.id,projection);
    }
    return projection;
  }
  private pumpTopicField(session: TopicSession, field: 'name' | 'icon'): void {
    const projection = this.topicProjections.get(session.id);
    if (!projection) return;
    const owned = () => !this.stopped && !this.options.config.terminated && this.sessionAssigned(session) &&
      this.topicProjections.get(session.id) === projection;
    const eligible = () => {
      if (!owned()) return false;
      const goal = topicGoal(projection[field]);
      const status = this.options.store.getSession(session.id)?.status;
      return goal !== undefined && goal.generation === this.options.store.getSessionGeneration(session.id) &&
        (status === 'open' || (field === 'icon' && status === 'closed' && projection.activity === 'finished' &&
          this.closedSessions.get(session.id)?.settled === true));
    };
    if (!eligible()) {
      projection[field] = transitionTopicField(projection[field],{type:'publish'});
      return;
    }
    projection[field] = transitionTopicField(projection[field],{type:'expire',now:Date.now()});
    const ticket = ++this.topicTicket;
    projection[field] = transitionTopicField(projection[field],{type:'queue',ticket,now:Date.now()});
    const queued = projection[field];
    if (queued.kind !== 'queued' || queued.ticket !== ticket) return;
    const pending = this.delivery.runTopic(session.chatId,field,session.id,async signal => {
      if (!eligible()) return;
      projection[field] = transitionTopicField(projection[field],{type:'dispatch',ticket});
      const sent = projection[field];
      if (sent.kind !== 'sending' || sent.attempt.ticket !== ticket) return;
      const value = sent.attempt.target.value;
      try {
        await this.bot.api.editForumTopic(session.chatId,session.threadId,
          field === 'name' ? {name:value} : {icon_custom_emoji_id:value},signal).catch(error => {
          if (!(error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED'))) throw error;
        });
        projection[field] = transitionTopicField(projection[field],{type:'success',ticket,now:Date.now(),lifetime:projection.lifetime});
        if (eligible() && field === 'name' && projection[field].kind === 'confirmed') {
          this.options.store.setTopicTitle(session.id,value,projection.currentPrefix);
        }
        if (owned()) this.pumpTopicField(session,field);
      } catch (error) {
        projection[field] = transitionTopicField(projection[field],{type:'failure',ticket,retryAt:Date.now()+30_000});
        throw error;
      }
    },() => {
      const queued = projection[field];
      return eligible() && queued.kind === 'queued' && queued.ticket === ticket;
    })
      .catch(error => {
        projection[field] = transitionTopicField(projection[field],{type:'failure',ticket,retryAt:Date.now()+30_000});
        this.sessionObservation(session.id).failure = {operation:field === 'name' ? 'Topic title synchronization' : 'Topic icon synchronization',at:Date.now(),error};
        if (field === 'icon') console.warn(`Could not update topic status (${session.id}, ${projection.activity}).`,error);
      });
    projection.completion[field] = pending.then(() => undefined);
  }
  private setTopicStatus(session: TopicSession, activity: TopicActivity): Promise<void> {
    if (this.stopped || this.options.config.terminated || !this.sessionAssigned(session)) return Promise.resolve();
    const status = this.options.store.getSession(session.id)?.status;
    if (status !== 'open' && !(status === 'closed' && activity === 'finished' &&
        this.closedSessions.get(session.id)?.settled === true)) {
      this.invalidateTopicStatus(session.id);
      return Promise.resolve();
    }
    const projection = this.topicProjection(session);
    const generation = this.options.store.getSessionGeneration(session.id);
    if (projection.activity !== activity || projection.generation !== generation) {
      projection.icon = transitionTopicField(projection.icon,{type:'publish'});
    }
    projection.activity = activity;
    projection.generation = generation;
    const revision = ++projection.revision;
    if (activity === 'unknown') {
      projection.icon = transitionTopicField(projection.icon,{type:'publish'});
      return Promise.resolve();
    }
    return this.getIconIds().then(async ids => {
      if (this.topicProjections.get(session.id) !== projection ||
          (projection.revision !== revision && projection.activity !== activity) ||
          generation !== this.options.store.getSessionGeneration(session.id)) return;
      if (this.stopped || this.options.config.terminated || !this.sessionAssigned(session)) return;
      const preference = this.options.store.getTopicFinishIcon(session.id);
      if (preference === ids.running) this.options.store.setTopicFinishIcon(session.id,undefined);
      const value = activity === 'finished' ? (preference === ids.running ? ids.finished : preference ?? ids.finished) : ids.running;
      projection.icon = transitionTopicField(projection.icon,{type:'publish',target:{generation,value}});
      this.pumpTopicField(session,'icon');
      for (;;) {
        const completion = projection.completion.icon;
        await completion;
        if (projection.completion.icon === completion) break;
      }
    }).catch(error => {
      this.sessionObservation(session.id).failure = {operation:'Topic icon synchronization',at:Date.now(),error};
    });
  }
  private observeExistingSession(session: TopicSession): Promise<void> {
    const existing = this.hostObservations.get(session.id);
    if (existing) return existing;
    const generation = this.options.store.getSessionGeneration(session.id);
    const projection = this.topicProjection(session);
    const active = () => !this.stopped && !this.options.config.terminated && this.sessionAssigned(session) &&
      this.options.store.getSession(session.id)?.status === 'open' &&
      this.options.store.getSessionGeneration(session.id) === generation && !this.listeners.has(session.id) &&
      this.topicProjections.get(session.id) === projection;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.background.signal,controller.signal]);
    const timeout = setTimeout(() => controller.abort(new Error('Host activity lookup timed out after 5 seconds')),5000);
    const observation = (async () => {
      if (!active()) return;
      if (Date.now() - (projection.activityObservedAt ?? 0) >= 60_000) void this.setTopicStatus(session,'unknown');
      const binding = await withCancellation(this.options.runtime.resolveExisting(session),signal);
      if (!active()) return;
      if (!binding) {
        projection.activityObservedAt = Date.now();
        void this.setTopicStatus(session,'finished');
        return;
      }
      const state = await withCancellation(
        (this.options.readState ?? readCollabState)(binding,`Telegram @${this.bot.botInfo!.username} activity`,signal),signal);
      if (!active()) return;
      projection.activityObservedAt = Date.now();
      void this.setTopicStatus(session,state.isStreaming || state.queuedMessageCount > 0 ||
        this.options.store.hasPendingInitialTask(session.id) ? 'running' : 'finished');
    })().catch(error => {
      if (active()) {
        void this.setTopicStatus(session,'unknown');
        this.sessionObservation(session.id).failure = {operation:'Host status lookup',at:Date.now(),error};
      }
    }).finally(() => {
      clearTimeout(timeout);
      if (this.hostObservations.get(session.id) === observation) this.hostObservations.delete(session.id);
    });
    this.hostObservations.set(session.id, observation);
    return observation;
  }
  private refreshActivity(session: TopicSession, listener: Listener): Promise<void> {
    if (listener.activityProbe) return listener.activityProbe;
    const revision = listener.activityRevision;
    const controller = new AbortController();
    listener.activityProbeController = controller;
    const signal = AbortSignal.any([this.background.signal,controller.signal]);
    const timeout = setTimeout(() => controller.abort(new Error('Host activity lookup timed out after 5 seconds')),5000);
    const active = () => !this.stopped && !this.options.config.terminated && this.sessionAssigned(session) &&
      this.listeners.get(session.id) === listener && listener.activityRevision === revision &&
      this.options.store.getSessionGeneration(session.id) === listener.generation &&
      this.options.store.getSession(session.id)?.status === 'open';
    const probe = (async () => {
      const binding = await withCancellation(this.options.runtime.resolveExisting(session),signal);
      if (!active()) return;
      if (!binding) {
        listener.activity = 'finished';
        listener.activityObservedAt = Date.now();
        listener.activitySuspect = false;
        return;
      }
      const state = await withCancellation(
        (this.options.readState ?? readCollabState)(binding,`Telegram @${this.bot.botInfo!.username} activity`,signal),signal);
      if (!active()) return;
      listener.queuedMessages = state.queuedMessageCount;
      listener.activity = this.options.store.hasPendingInitialTask(session.id) || state.isStreaming || state.queuedMessageCount > 0 ? 'running' : 'finished';
      listener.activityObservedAt = Date.now();
      listener.activitySuspect = false;
    })().catch(error => {
      if (active()) {
        listener.activity = 'unknown';
        listener.activityObservedAt = undefined;
        listener.activitySuspect = true;
        void this.setTopicStatus(session,'unknown');
        this.sessionObservation(session.id).failure = {operation:'Host status lookup',at:Date.now(),error};
      }
    }).finally(() => {
      clearTimeout(timeout);
      if (listener.activityProbe === probe) {
        listener.activityProbe = undefined;
        listener.activityProbeController = undefined;
      }
    });
    listener.activityProbe = probe;
    return probe;
  }
  private async refreshTopicStatus(session: TopicSession): Promise<void> {
    if (this.stopped || this.options.config.terminated || !this.sessionAssigned(session)) return;
    if (this.options.store.getSession(session.id)?.status === 'closed') {
      const state = this.closedSessions.get(session.id);
      if (!state || state.generation !== this.options.store.getSessionGeneration(session.id) || (!state.settled && !state.pending)) {
        void this.runBackground(`close:${session.id}`,() => this.windDownClosedSession(session));
      } else if (state.settled) {
        void this.setTopicStatus(session,'finished');
      }
      return;
    }
    const generation = this.options.store.getSessionGeneration(session.id);
    let listener = this.listeners.get(session.id);
    if (listener && listener.generation !== generation) {
      this.dropListener(session.id);
      listener = undefined;
    }
    if (!listener) {
      const projection = this.topicProjection(session);
      const revision = projection.titleRevision;
      const title = this.options.store.getPendingSessionTitle(session.id) ?? projection.humanTitle ??
        this.stripTopicStatus(session,session.name);
      void this.projectTopicTitle(session,title,() => !this.stopped && this.sessionAssigned(session) &&
        this.options.store.getSession(session.id)?.status === 'open' &&
        this.options.store.getSessionGeneration(session.id) === generation && projection.titleRevision === revision &&
        this.topicProjections.get(session.id) === projection);
      await this.observeExistingSession(session);
      if (this.stopped || !this.sessionAssigned(session) || this.options.store.getSessionGeneration(session.id) !== generation) return;
      listener = this.listeners.get(session.id);
    }
    if (listener) {
      this.syncTopicTitle(session,listener);
      if (listener.activitySuspect || Date.now() - (listener.activityObservedAt ?? 0) >= 30_000) {
        if (listener.activitySuspect || Date.now() - (listener.activityObservedAt ?? 0) >= 60_000) {
          listener.activity = 'unknown';
          void this.setTopicStatus(session,'unknown');
        }
        await this.refreshActivity(session,listener);
      }
      if (this.stopped || !this.sessionAssigned(session) || this.listeners.get(session.id) !== listener ||
          this.options.store.getSessionGeneration(session.id) !== generation ||
          this.options.store.getSession(session.id)?.status !== 'open') return;
      void this.setTopicStatus(session,listener.activity);
    } else {
      const icon = this.topicProjections.get(session.id);
      if (icon?.generation === generation) void this.setTopicStatus(session,icon.activity);
    }
  }
  private windDownClosedSession(session: TopicSession): Promise<void> {
    const generation = this.options.store.getSessionGeneration(session.id);
    let state = this.closedSessions.get(session.id);
    if (!state || state.generation !== generation) {
      state = {generation,settled:false};
      this.closedSessions.set(session.id,state);
      this.options.store.cancelInitialTask(session.id);
      this.invalidateTopicStatus(session.id);
      this.dropListener(session.id);
      for (const [token, request] of this.capacityRequests) {
        if (request.sessionId === session.id) this.capacityRequests.delete(token);
      }
      for (const [token, proposal] of this.promptProposals) {
        if (proposal.sessionId === session.id) this.promptProposals.delete(token);
      }
    }
    if (state.settled) return this.setTopicStatus(session,'finished');
    if (state.pending) return state.pending;
    const current = state;
    const pending = (session.runtime.kind === 'attached'
      ? this.options.runtime.isRunning(session).then(running => !running)
      : this.options.runtime.stop(session)).then(async settled => {
      if (this.stopped || this.options.config.terminated || !this.sessionAssigned(session) ||
          this.closedSessions.get(session.id) !== current ||
          this.options.store.getSessionGeneration(session.id) !== generation ||
          this.options.store.getSession(session.id)?.status !== 'closed') return;
      current.settled = settled;
      if (settled) await this.setTopicStatus(session,'finished');
    }).finally(() => { current.pending = undefined; });
    current.pending = pending;
    return pending;
  }

  private async detachSession(session: TopicSession): Promise<void> {
    this.options.store.setPendingSessionTitle(session.id,undefined);
    this.options.store.updateSession(session.id,{status:'detached'});
    this.options.store.advanceSessionGeneration(session.id);
    this.options.store.cancelInitialTask(session.id);
    this.dropListener(session.id);
    this.closedSessions.delete(session.id);
    for (const [token, request] of this.capacityRequests) {
      if (request.sessionId === session.id) this.capacityRequests.delete(token);
    }
    for (const [token, proposal] of this.promptProposals) {
      if (proposal.sessionId === session.id) this.promptProposals.delete(token);
    }
    for (const handler of this.sessionInvalidationHandlers) handler(session.id);
    const icon = this.topicProjections.get(session.id);
    await icon?.completion.icon;
    this.topicProjections.delete(session.id);
    try {
      await this.delivery.runTopic(session.chatId,'icon',session.id, signal => this.bot.api.editForumTopic(
        session.chatId,session.threadId,{icon_custom_emoji_id:''},signal), () => !this.stopped &&
          this.options.store.getSession(session.id)?.status === 'detached' &&
          findInstance(this.options.config,this.id,session.chatId)?.path === session.instancePath);
    } catch (error) {
      if (!(error instanceof GrammyError && error.description.includes('TOPIC_NOT_MODIFIED'))) throw error;
    }
  }
  private async announce(session: TopicSession): Promise<void> {
    this.requireSessionAssignment(session);
    const text = this.allMessagesArePrompts(session.chatId) ? 'Send a message to prompt the agent' : 'Use /p to submit a prompt';
    const message = await sendTo(this.bot.api, topicDestination(session.chatId, session.threadId), text, {reply_markup:this.sessionMarkup(session)});
    this.options.store.setSessionEntry(session.id,message.message_id,JSON.stringify(this.sessionMarkup(session)));
    this.requireSessionAssignment(session);
    await this.bot.api.pinChatMessage(session.chatId, message.message_id, { disable_notification: true });
  }
  private async newSession(ctx: Context, task?: PromptContent, attached?: { instanceId: string; sessionId: string; instancePath: string }, name?: string, accepted?: () => void, worktree = false, authority = ctx): Promise<void> {
    await this.authorize(ctx.chat!.id, ctx.from!.id);
    const instancePath = this.assignedPath(ctx.chat!.id);
    if (attached && attached.instancePath !== instancePath) throw new Error('The group instance assignment changed');
    if (worktree && attached) throw new Error('Attached sessions cannot create managed worktrees');
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    const title = (name ?? task?.text.replace(/(?:^|\s)\/skill:[^\s]+/g, ' ') ?? '').replace(/\s+/g, ' ').trim().slice(0, 128) || 'OMP session';
    const initialIcon = task !== undefined && !worktree ? (await this.getIconIds()).running : undefined;
    if (!(await this.currentAdmin(authority))) throw new Error('Administrator access changed before topic creation.');
    const topic = await this.bot.api.createForumTopic(ctx.chat!.id, title, initialIcon ? {icon_custom_emoji_id:initialIcon} : {});
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    const automaticWorktree = !attached && !worktree && this.createsTopicWorktrees(ctx.chat!.id);
    const session = this.options.store.createSession({ botId: this.id, chatId: ctx.chat!.id, threadId: topic.message_thread_id, instancePath }, title, attached ? { kind:'attached', instanceId:attached.instanceId, sessionId:attached.sessionId } : {kind:'managed'}, attached || worktree || automaticWorktree ? undefined : task, ctx.from!.id, authority.from!.id);
    if (automaticWorktree) {
      await this.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.currentAdmin(authority))) throw new Error('Administrator access changed before worktree creation.');
      await this.createTopicWorktree(session);
      if (task !== undefined) {
        await this.authorize(ctx.chat!.id, ctx.from!.id);
        if (!(await this.currentAdmin(authority))) throw new Error('Administrator access changed before initial task submission.');
        this.requireSessionAssignment(session);
        this.options.store.setInitialTask(session.id, task, ctx.from!.id, authority.from!.id);
      }
    }
    if (worktree) {
      const text = await this.options.runtime.worktree(session, task?.text || undefined);
      this.options.store.setSessionRuntime(session.id, session.runtime);
      task = undefined;
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
    if (task !== undefined && ctx.message) this.options.store.setReplyTarget(session.id,ctx.message.message_id);
    await replyTo(ctx, contextDestination(ctx), `Topic created: https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`, {
      reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
    });
    await this.announce(session);
    const source = ctx.message;
    if (task !== undefined && source?.reply_to_message) {
      await forwardTo(this.bot.api, topicDestination(session.chatId, session.threadId),
        ctx.chat!.id, source.reply_to_message.message_id);
    }
    if (task !== undefined) for (const original of this.albumPrompts.get(ctx)?.contexts ?? [ctx]) {
      if (original.message) await forwardTo(this.bot.api, topicDestination(session.chatId, session.threadId),
        ctx.chat!.id, original.message.message_id);
    }
    await this.setTopicStatus(session, task !== undefined ? 'running' : 'unknown');
    await this.listen(session);
    await this.sendInitial(session);
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
  private async promptImages(attachments: TelegramImage[]): Promise<ImageContent[]> {
    return Promise.all(attachments.map(async ({fileId,mimeType}): Promise<ImageContent> => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error(`Unsupported image type: ${mimeType}`);
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) throw new Error('Telegram image file path is unavailable');
      const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
      if (!response.ok) throw new Error(`Telegram image download failed: ${response.status} ${response.statusText}\n${await response.text()}`);
      return {type:'image',data:Buffer.from(await response.arrayBuffer()).toString('base64'),mimeType};
    }));
  }
  private defaultNewTopicSkill(chatId: number): string | undefined {
    return findInstance(this.options.config,this.id,chatId)?.instance.chats
      .find(chat => chat.botId === this.id && chat.chatId === chatId)?.default_new_topic_skill;
  }
  private async routePrompt(ctx: Context, content: PromptContent, session?: TopicSession, immediateSkill?: string, worktree = false): Promise<void> {
    const admin = await this.currentAdmin(ctx);
    if (!admin && !this.usersCanProposePrompts(ctx.chat!.id)) return;
    await this.authorize(ctx.chat!.id, ctx.from!.id);
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
      content = {...content,text:`${mentionedSkills.map(name => `/skill:${name}`).join(' ')}\n\n${content.text}`};
    }
    if (this.assignedPath(ctx.chat!.id) !== instancePath) throw new Error('The group instance assignment changed');
    if (session && (this.options.store.getSessionGeneration(session.id) !== generation ||
        this.options.store.getSession(session.id)?.status !== 'open')) throw new Error('The session changed while downloading the image');
    if (await this.currentAdmin(ctx)) {
      if (session) {
        await this.submitSessionPrompt(ctx, session, content, {key:skillKey,names:pendingSkills,topicSkill});
      } else await this.newSession(ctx, content, undefined, undefined, !worktree ? () => this.options.store.clearPendingSkills(skillKey) : undefined, worktree);
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
      source:ctx,content,instancePath,worktree,
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
      if (!(await this.submitSessionPrompt(proposal.source,session,proposal.content,undefined,ctx))) {
        await ctx.editMessageText('Prompt not submitted: the initial task is still being admitted. Propose it again after startup.');
        return;
      }
    } else await this.newSession(proposal.source,proposal.content,undefined,undefined,undefined,proposal.worktree,ctx);
    await ctx.editMessageText('Prompt approved.',{reply_markup:{inline_keyboard:[]}});
  }
  private async submitSessionPrompt(ctx: Context, session: TopicSession, content: PromptContent, selected?: {key:PendingSkillKey;names:string[];topicSkill?:string}, authority = ctx): Promise<boolean> {
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
      this.sendPrompt(this.listeners.get(session.id)!,content,messageId,restore);
    } catch (error) {
      this.options.store.setReplyTarget(session.id,previousTarget);
      restore?.();
      throw error;
    }
    return true;
  }
  private async handle(ctx: Context, intent: InputIntent): Promise<void> {
    if (this.stopped || intent.kind === 'ignore') return;
    if (intent.kind === 'command' && intent.action === 'status' && ctx.chat?.type !== 'private') {
      if (intent.argument) { await replyTo(ctx,contextDestination(ctx),'Usage: /status'); return; }
      await this.showStatus(ctx);
      return;
    }
    if (refreshTermination(this.options.config)) {
      try { await this.applyTermination(); }
      finally {
        if (ctx.chat && (ctx.callbackQuery || intent.kind !== 'event')) await replyTo(ctx, contextDestination(ctx), terminationMessage);
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
    const topicLifecycle = intent.kind === 'event';
    const command = intent.kind === 'command' ? {action:intent.action,argument:intent.argument} : undefined;
    if (command?.action === 'terminate') {
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
      await replyTo(ctx, contextDestination(ctx), `Add me to your own supergroup, enable Topics, grant Manage Topics and Pin Messages, then run /setup.${this.options.config.publicUrl ? ' Configure the Mini App URL in BotFather for this bot.' : ''}`, {reply_markup:{inline_keyboard:[[{text:'Add to Group',url:`https://t.me/${this.bot.botInfo!.username}?startgroup=setup&admin=manage_topics+pin_messages`}]]}}); return;
    }
    if (command?.action === 'setup') { await this.setup(ctx); return; }
    const assigned = findInstance(this.options.config, this.id, ctx.chat.id);
    if (!assigned || !this.options.store.isEnrolled(this.id, ctx.chat.id)) {
      if (command?.action === 'help') {
        await replyTo(ctx, contextDestination(ctx), `${this.commandHelp()}\n${settingsHelp}\n${adminHelp}${await this.currentAdmin(ctx) ? `\n${cliHelp}` : ''}\n${this.promptHelp(ctx.chat.id)}`);
      }
      return;
    }
    if (command?.action === 'settings') { await this.openSettings(ctx); return; }
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
        if (this.createsTopicWorktrees(ctx.chat.id)) {
          await this.authorize(ctx.chat.id,ctx.from!.id);
          await this.createTopicWorktree(session);
        }
        await this.announce(session);
        await this.refreshTopicStatus(session);
      }
      return;
    }
    if (session && message.forum_topic_edited) {
      const edited = message.forum_topic_edited;
      const attributable = ctx.from !== undefined && ctx.from.id !== this.id && !message.sender_chat;
      const projection = this.topicProjections.get(session.id);
      for (const field of ['name','icon'] as const) {
        const value = field === 'name' ? edited.name : edited.icon_custom_emoji_id;
        if (value !== undefined && projection) {
          projection[field] = transitionTopicField(projection[field],{type:'notice',value});
          if (!detached) this.pumpTopicField(session,field);
        }
      }
      if (edited.icon_custom_emoji_id !== undefined && attributable) {
        const generation = this.options.store.getSessionGeneration(session.id);
        void this.getIconIds().then(ids => {
          if (this.stopped || this.options.config.terminated ||
              generation !== this.options.store.getSessionGeneration(session.id) ||
              (detached ? this.options.store.getSession(session.id)?.status !== 'detached' ||
                findInstance(this.options.config,this.id,session.chatId)?.path !== session.instancePath
                : !this.sessionAssigned(session))) return;
          if (edited.icon_custom_emoji_id !== ids.running) this.options.store.setTopicFinishIcon(session.id,edited.icon_custom_emoji_id);
          if (!detached && projection) void this.setTopicStatus(session,projection.activity);
        }).catch(error => {
          this.sessionObservation(session.id).failure = {operation:'Topic icon synchronization',at:Date.now(),error};
        });
      }
      if (edited.name !== undefined && attributable) {
        const title = this.stripTopicStatus(session,edited.name);
        const listener = this.listeners.get(session.id);
        if (listener) listener.sessionTitle = title;
        const source = this.topicProjection(session);
        if (source.humanTitle !== title) source.name = transitionTopicField(source.name,{type:'publish'});
        source.humanTitle = title;
        const prefix = [this.options.store.getTopicTitlePrefix(session.id) ?? '',...source.prefixes]
          .find(prefix => prefix !== '' && edited.name?.startsWith(`${prefix} `)) ?? '';
        this.options.store.setTopicTitle(session.id,edited.name,prefix);
        ++source.titleRevision;
        if (!detached) {
          this.options.store.setPendingSessionTitle(session.id,title);
          const revision = source.titleRevision;
          const generation = this.options.store.getSessionGeneration(session.id);
          void this.projectTopicTitle(session,title,() => !this.stopped && !refreshTermination(this.options.config) &&
            this.sessionAssigned(session) && this.options.store.getSession(session.id)?.status === 'open' &&
            source.titleRevision === revision &&
            this.options.store.getSessionGeneration(session.id) === generation);
          void this.applySessionTitle(session).catch(error => {
            this.sessionObservation(session.id).failure = {operation:'Topic title synchronization',at:Date.now(),error};
          });
        }
      }
      if (ctx.from?.id === this.id && (edited.icon_custom_emoji_id !== undefined || edited.name !== undefined)) {
        await this.delivery.run(ctx.chat.id,
          () => this.bot.api.deleteMessage(ctx.chat!.id,message.message_id),
          () => !this.stopped && (detached
            ? this.options.store.getSession(session.id)?.status === 'detached' &&
              findInstance(this.options.config,this.id,session.chatId)?.path === session.instancePath
            : this.sessionAssigned(session))).catch(error => {
          console.warn(`Could not delete topic edit notice (${session.id}, ${message.message_id}).`, error);
        });
      }
      return;
    }
    if (session && 'forum_topic_closed' in message) {
      if (this.options.store.getSession(session.id)?.status !== 'closed') {
        this.options.store.updateSession(session.id,{status:'closed'});
        this.options.store.advanceSessionGeneration(session.id);
      }
      this.options.store.cancelInitialTask(session.id);
      this.dropListener(session.id);
      for (const handler of this.sessionInvalidationHandlers) handler(session.id,'This topic is closed. Reopen it explicitly to connect.');
      void this.runBackground(`close:${session.id}`,() => this.windDownClosedSession(session));
      return;
    }
    if (session && 'forum_topic_reopened' in message) {
      this.options.store.updateSession(session.id,{status:'open'});
      this.closedSessions.delete(session.id);
      return;
    }
    if (!ctx.from || ctx.from.is_bot) return;
    if (session?.status === 'closed' && !['status','help'].includes(command?.action ?? '')) {
      await replyTo(ctx,destination,'This topic is closed. Reopen it in Telegram or confirm reopening in the Mini App before sending work.');
      return;
    }
    if (intent.kind === 'question-answer') {
      await this.authorize(ctx.chat.id,ctx.from.id);
      const pending = this.questions.get(intent.token);
      if (!pending) {
        await replyTo(ctx,destination,'This question is no longer active. Answer the latest question instead.');
        return;
      }
      if (pending.request.kind === 'editor') this.submitAnswer(intent.token,intent.text,undefined,message.message_id);
      else await replyTo(ctx,destination,'Use the numbered answer buttons on the question.');
      return;
    }
    if (intent.kind === 'ended-question') {
      await this.authorize(ctx.chat.id,ctx.from.id);
      await replyTo(ctx,destination,'This question is no longer active. Answer the latest question instead.');
      return;
    }
    if (intent.kind === 'skill-selection') {
      if (!detached) await this.skills.selection(ctx,intent.text,session);
      return;
    }
    if (intent.kind === 'new-task' || intent.kind === 'session-prompt') {
      if (detached && intent.kind !== 'new-task') return;
      if (intent.kind === 'session-prompt' && destination.kind !== 'general' && !session) {
        await replyTo(ctx,destination,'No session in this topic. Use /new to create one.');
        return;
      }
      if (!this.usersCanProposePrompts(ctx.chat.id) && !(await this.currentAdmin(ctx))) return;
      if (!intent.content.text.trim() && !intent.content.images.length) {
        if (intent.kind === 'session-prompt' && destination.kind !== 'general') await replyTo(ctx,destination,'Usage: /p <prompt>');
        return;
      }
      await this.authorize(ctx.chat.id,ctx.from.id);
      const instancePath = this.assignedPath(ctx.chat.id);
      const generation = session && this.options.store.getSessionGeneration(session.id);
      const images = await this.promptImages(intent.content.images);
      if (this.assignedPath(ctx.chat.id) !== instancePath ||
          (session && this.options.store.getSessionGeneration(session.id) !== generation)) throw new Error('The session or group assignment changed while downloading the image');
      await this.routePrompt(ctx,{text:intent.content.text,...(images.length ? {images} : {})},intent.kind === 'new-task' ? undefined : session,intent.skill);
      return;
    }
    if (command) {
      await this.authorize(ctx.chat.id, ctx.from.id);
      const action = command.action;
      const arg = command.argument;
      if (action === 'list_admins') {
        if (arg) { await replyTo(ctx, destination, 'Usage: /list_admins'); return; }
        await this.listAdmins(ctx);
        return;
      }
      if (action === 'usage') {
        if (arg) { await replyTo(ctx, destination, 'Usage: /usage'); return; }
        const usage = await this.options.runtime.providerUsage(assigned.path);
        const text = usage.map(section => `${section.heading ? `**${section.heading}**\n\n` : ''}${section.table}`).join('\n\n');
        await ctx.api.sendRichMessage(destination.chatId, { markdown: text }, {
          message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined,
        });
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
      if (action === 'worktree') {
        if (destination.kind === 'general') { await this.routePrompt(ctx,{text:arg},undefined,undefined,true); return; }
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
        await this.newSession(ctx,undefined,{instanceId:binding.instanceId,sessionId:binding.sessionId,instancePath},match[2] ?? 'Attached OMP session'); return;
      }
      if (action === 'help' || action === 'start') { await replyTo(ctx, contextDestination(ctx), `${this.commandHelp()}\n${settingsHelp}\n${adminHelp}${await this.currentAdmin(ctx) ? `\n${cliHelp}` : ''}\n/skills — select or clear skills for your next prompt\n/skill_* — select a skill; include task text to submit immediately\n${this.promptHelp(ctx.chat.id)}`); return; }
      if (action === 'cli') {
        if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, destination, 'This command requires a current group administrator.'); return; }
        if (arg) { await replyTo(ctx, destination, 'Usage: /cli'); return; }
        if (destination.kind !== 'topic' || !session) { await replyTo(ctx, destination, 'Use /cli in an active session topic.'); return; }
        this.requireSessionAssignment(session);
        if (session.status !== 'open') { await replyTo(ctx, destination, 'This session is archived. Reopen the topic before joining.'); return; }
        const command = `omp-telegram session join --chat ${destination.chatId} --topic ${destination.threadId}`;
        await replyTo(ctx, destination, `Run this on the bot machine as the service OS account. If needed, supply --config with your operator configuration path. Copying the command does not grant access.\n<pre>${command}</pre>`, {
          parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'Copy command',copy_text:{text:command}}]]},
        });
        return;
      }
      if (action === 'session') {
        if (!this.options.config.publicUrl) { await replyTo(ctx, contextDestination(ctx), 'The Mini App is disabled. Continue using this topic to interact with the agent in Telegram.'); return; }
        if (!session) { await replyTo(ctx, contextDestination(ctx), 'No session in this topic. Use /new task or create a topic.'); return; }
        await replyTo(ctx, contextDestination(ctx), `${session.name} (${session.status})`,{reply_markup:this.sessionMarkup(session)});
        return;
      }
      if (action === 'model_preset') {
        if (!(await this.currentAdmin(ctx))) { await replyTo(ctx, contextDestination(ctx), 'Model preset commands require a group administrator.'); return; }
        if (destination.kind !== 'topic' || !session) { await this.replyPresetUsage(ctx, assigned.path, '\nUse this command in a session topic. Use /settings for forum defaults.'); return; }
        if (session && session.status !== 'open') { await replyTo(ctx, contextDestination(ctx), 'This session is archived. Reopen the topic before using model preset commands.'); return; }
        if (arg && !/^[A-Za-z][\w-]*$/.test(arg)) {
          await this.replyPresetUsage(ctx, session.instancePath);
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
          let text = await this.options.runtime.modelPresets(session,arg || undefined);
          if (!arg) {
            const preset = findInstance(this.options.config,this.id,ctx.chat.id)!.instance.chats
              .find(chat => chat.botId === this.id && chat.chatId === ctx.chat!.id)?.default_model_preset;
            text += `\nDefault model preset: ${preset ?? '(not set)'}`;
            text = `Usage: /model_preset to list presets, or /model_preset <name> to switch an idle session.\n${text}`;
          }
          await this.replyPresetText(ctx, text);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'OMP host is busy; wait for the current turn and queued messages to finish before switching model presets') throw error;
          await replyTo(ctx, contextDestination(ctx), "Can't change model preset while busy. /stop first");
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
        if (listener) {
          listener.activity = 'unknown';
          ++listener.frameRevision;
          ++listener.activityRevision;
        }
        this.invalidateTopicStatus(session.id);
        for (const [token, request] of this.capacityRequests) {
          if (request.sessionId === session.id) this.capacityRequests.delete(token);
        }
        if (action === 'kill') {
          this.options.store.advanceSessionGeneration(session.id);
          this.dropListener(session.id);
          for (const handler of this.sessionInvalidationHandlers) handler(session.id);
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
        const activeListener = this.listeners.get(session.id);
        if (!activeListener || activeListener.connection !== connection ||
            activeListener.generation !== this.options.store.getSessionGeneration(session.id)) throw new Error('Session closed');
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
    }
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
          if (this.options.store.hasPendingInitialTask(active.id)) {
            await withCancellation(this.sendInitial(active),signal);
          } else {
            await this.recoverExistingMirror(active,signal);
          }
          await withCancellation(this.refreshTopicStatus(active), signal);
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
    this.invalidateTopicStatus(id);
    clearTimeout(this.reconnects.get(id));
    this.reconnects.delete(id);
    const listener = this.listeners.get(id);
    for (const pending of listener?.pendingPrompts ?? []) pending.observation.state = 'acceptance unknown';
    this.listeners.delete(id);
    clearTimeout(listener?.initial?.timer);
    if (listener) {
      listener.activityProbeController?.abort(new Error('Activity observation canceled because its listener closed'));
      listener.initial = undefined;
      listener.activity = 'unknown';
    }
    for (const [token, question] of this.questions) {
      if (question.listener === listener) this.endQuestion(token);
    }
    listener?.connection?.close();
  }
  private listen(session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>, existingOnly = false, recoverClosed = true): Promise<CollabConnection> {
    if (existingOnly && !binding) return Promise.reject(new Error('Existing host binding is required'));
    this.requireSessionAssignment(session);
    if (this.options.store.getSession(session.id)?.status !== 'open') return Promise.reject(new Error('This topic is closed. Reopen it before connecting.'));
    const generation = this.options.store.getSessionGeneration(session.id);
    const existing = this.listeners.get(session.id);
    if (existing?.promise && existing.generation === generation) return existing.promise;
    if (existing) this.dropListener(session.id);
    const listener: Listener = {
      sessionId:session.id,generation,frameRevision:0,activityRevision:0,tail:Promise.resolve(),queued:0,
      recovering:this.options.store.hasSnapshot(session.id),pendingPrompts:[],pendingAnswers:new Map(),
      pendingStops:[],queuedMessages:0,activity:this.options.store.hasPendingInitialTask(session.id) ? 'running' : 'unknown',
    };
    this.listeners.set(session.id, listener);
    void this.setTopicStatus(session,listener.activity);
    const active = () => !this.stopped && !this.options.config.terminated && this.sessionAssigned(session) &&
      this.options.store.getSession(session.id)?.status === 'open' &&
      this.options.store.getSessionGeneration(session.id) === generation && this.listeners.get(session.id) === listener;
    const closed = new Error('Session closed');
    listener.promise = (binding ? Promise.resolve(binding) : this.options.runtime.ensure(session,beforeMutation)).then(async binding => {
      if (!active()) throw closed;
      await beforeMutation?.();
      if (!active()) throw closed;
      await this.applySessionTitle(session);
      if (!active()) throw closed;
      return (this.options.connect ?? connectCollab)(binding,`Telegram @${this.bot.botInfo!.username}`,{
        onFrame: frame => this.onFrame(session,listener,frame),
        onClose: reason => {
          if (!active()) return;
          this.sessionObservation(session.id).failure = {operation:'Mirroring disconnected',at:Date.now(),error:reason};
          const connected = listener.connection !== undefined;
          this.dropListener(session.id);
          if (connected) this.scheduleReconnect(session);
        },
      });
    }).then(connection => {
      if (!active()) { connection.close(); throw closed; }
      this.sessionObservation(session.id).mirrored = true;
      listener.connection = connection;
      return connection;
    }).catch(async error => {
      if (active()) this.sessionObservation(session.id).failure = {operation:'Session connection',at:Date.now(),error};
      try {
        if (!existingOnly && error instanceof SessionCapacityError && active()) await this.requestCapacity(session,error.limit);
        if (error !== closed || !recoverClosed || existingOnly || this.stopped || refreshTermination(this.options.config) ||
            !this.sessionAssigned(session) || this.options.store.getSession(session.id)?.status !== 'open' ||
            this.options.store.getSessionGeneration(session.id) !== generation) throw error;
      } finally {
        if (this.listeners.get(session.id) === listener) this.dropListener(session.id);
      }
      return this.listen(session,undefined,beforeMutation,false,false);
    });
    return listener.promise;
  }
  private sendPrompt(listener: Listener, content: PromptContent, messageId?: number, onStartupRejected?: () => void): void {
    const session = this.options.store.getSession(listener.sessionId);
    if (!session) throw new Error('Session no longer exists');
    this.requireSessionAssignment(session);
    if (session.status !== 'open') throw new Error('This topic is closed. Reopen it before submitting work.');
    if (this.listeners.get(session.id) !== listener ||
        listener.generation !== this.options.store.getSessionGeneration(session.id)) throw new Error('Session closed');
    const observation: TaskObservation = {state:'waiting for acceptance'};
    this.sessionObservation(session.id).task = observation;
    const pending = {content,messageId,onStartupRejected,observation};
    listener.pendingPrompts.push(pending);
    let attempted = false;
    try {
      this.options.runtime.markPrompt(listener.sessionId);
      attempted = true;
      listener.connection!.send({t:'prompt',text:content.text,...(content.images?.length ? {images:content.images} : {})});
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
    const listener = this.listeners.get(session.id);
    if (!listener) throw new Error('Session closed');
    if (this.stopped) throw this.background.signal.reason;
    if (!this.options.store.hasPendingInitialTask(session.id)) return;
    const userId = this.options.store.getInitialUser(session.id);
    const authorityUserId = this.options.store.getInitialAuthority(session.id);
    if (!userId || !authorityUserId) {
      this.options.store.cancelInitialTask(session.id);
      throw new Error('Initial task has no authorizing administrator. Submit the task again.');
    }
    await this.authorizeInitial(session, userId, authorityUserId);
    if (this.listeners.get(session.id) !== listener ||
        listener.generation !== this.options.store.getSessionGeneration(session.id)) throw new Error('Session closed');
    this.options.runtime.markPrompt(session.id);
    const task = this.options.store.claimInitialTask(session.id);
    if (task === undefined) return;
    const messageId = this.options.store.getReplyTarget(session.id);
    listener.initial = {content:task,userId,authorityUserId,messageId,deadline:Date.now()+this.options.config.omp.startupTimeoutMs,retries:0,phase:'sent'};
    listener.initial.timer = setTimeout(() => { listener.initial = undefined; },this.options.config.omp.startupTimeoutMs);
    listener.initial.timer.unref();
    this.sendPrompt(listener,task,messageId);
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
  private applySessionTitle(session: TopicSession): Promise<void> {
    const write = async () => {
      if (this.stopped || refreshTermination(this.options.config) || !this.sessionAssigned(session) ||
          this.options.store.getSession(session.id)?.status !== 'open') return;
      const title = this.options.store.getPendingSessionTitle(session.id);
      if (title === undefined) return;
      const generation = this.options.store.getSessionGeneration(session.id);
      try {
        await this.options.runtime.setSessionTitle(session,title);
      } catch (error) {
        this.sessionObservation(session.id).failure = {operation:'Session title synchronization',at:Date.now(),error};
        if (!this.stopped && error instanceof SessionTitleUnsupportedError &&
            this.options.store.getPendingSessionTitle(session.id) === title &&
            this.options.store.getSessionGeneration(session.id) === generation && this.sessionAssigned(session) &&
            this.options.store.getSession(session.id)?.status === 'open') {
          this.options.store.setPendingSessionTitle(session.id,undefined);
        }
      }
    };
    const previous = this.hostTitleWrites.get(session.id);
    const pending: Promise<void> = (previous ? previous.then(write,write) : write()).finally(() => {
      if (this.hostTitleWrites.get(session.id) === pending) this.hostTitleWrites.delete(session.id);
    });
    this.hostTitleWrites.set(session.id,pending);
    return pending;
  }
  private stripTopicStatus(session: TopicSession, title: string): string {
    const savedPrefix = this.options.store.getTopicTitlePrefix(session.id);
    if (savedPrefix && title.startsWith(`${savedPrefix} `)) return title.slice(savedPrefix.length+1);
    for (const prefix of this.topicProjections.get(session.id)?.prefixes ?? []) {
      if (title.startsWith(`${prefix} `)) return title.slice(prefix.length+1);
    }
    if (title.startsWith('🌳 ')) return title.slice('🌳 '.length);
    return title;
  }
  private async projectTopicTitle(session: TopicSession, title: string, active: () => boolean): Promise<void> {
    if (!active()) return;
    const owner = this.topicProjection(session);
    try {
      const status = await withCancellation(this.options.runtime.topicTitleStatus(session),
        AbortSignal.any([this.background.signal,AbortSignal.timeout(5000)]));
      if (!active() || this.topicProjections.get(session.id) !== owner) return;
      const topicBranch = `t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`;
      const branch = status.branch === topicBranch ? '' : status.branch ?? '';
      const statusText = status.worktree ? `🌳${branch ? ` ${branch}` : ''}` : branch;
      const prefixLimit = 127-Math.min(Array.from(title).length,64);
      const statusCharacters = Array.from(statusText);
      const prefix = statusCharacters.length > prefixLimit
        ? `${statusCharacters.slice(0,prefixLimit-1).join('')}…` : statusText;
      const projection = this.topicProjection(session);
      const prefixes = projection.prefixes;
      if (projection.humanTitle === undefined && prefix && title.startsWith(`${prefix} `)) title = title.slice(prefix.length+1);
      projection.humanTitle = title;
      const name = Array.from(`${prefix ? `${prefix} ` : ''}${title}`).slice(0,128).join('');
      if (!name.trim()) return;
      projection.currentPrefix = prefix;
      if (prefix) prefixes.add(prefix);
      projection.name = transitionTopicField(projection.name,{type:'publish',target:{
        generation:this.options.store.getSessionGeneration(session.id),value:name}});
      this.pumpTopicField(session,'name');
    } catch (error) {
      this.sessionObservation(session.id).failure = {operation:'Topic title synchronization',at:Date.now(),error};
    }
  }
  private syncTopicTitle(session: TopicSession, listener: Listener, title?: string): void {
    if (title !== undefined) listener.sessionTitle = title;
    else title = listener.sessionTitle;
    const generation = this.options.store.getSessionGeneration(session.id);
    const projection = this.topicProjection(session);
    if (title !== undefined && title !== projection.humanTitle) {
      projection.name = transitionTopicField(projection.name,{type:'publish'});
    }
    const revision = ++projection.titleRevision;
    const active = () => !this.stopped && !refreshTermination(this.options.config) &&
      this.sessionAssigned(session) && this.listeners.get(session.id) === listener &&
      this.options.store.getSession(session.id)?.status === 'open' &&
      this.options.store.getSessionGeneration(session.id) === generation &&
      projection.titleRevision === revision;
    void (async () => {
      if (!active()) return;
      const pending = this.options.store.getPendingSessionTitle(session.id);
      if (pending !== undefined) {
        if (pending === title) this.options.store.setPendingSessionTitle(session.id,undefined);
        else await this.applySessionTitle(session);
      }
      if (!active()) return;
      const human = this.options.store.getPendingSessionTitle(session.id) ??
        (pending === undefined ? title : undefined) ?? projection.humanTitle ??
        this.stripTopicStatus(session,this.options.store.getSession(session.id)?.name ?? session.name);
      if (pending !== undefined || title !== undefined) projection.humanTitle = human;
      await this.projectTopicTitle(session,human,active);
    })().catch(error => {
      this.sessionObservation(session.id).failure = {operation:'Topic title synchronization',at:Date.now(),error};
    });
  }
  private onFrame(session: TopicSession, listener: Listener, frame: HostFrame, replay = false): void {
    if (this.stopped || this.options.config.terminated || !this.sessionAssigned(session) ||
        this.listeners.get(session.id) !== listener ||
        this.options.store.getSessionGeneration(session.id) !== listener.generation) return;
    ++listener.frameRevision;
    if (frame.t === 'welcome' || frame.t === 'state' || frame.t === 'error' ||
        (frame.t === 'event' && (frame.event.type === 'agent_start' || frame.event.type === 'agent_end' ||
          miniAppInterruptionAuthor(frame.event) !== undefined))) {
      ++listener.activityRevision;
    }
    this.options.runtime.observeFrame(session.id,frame);
    if (frame.t === 'welcome' || (frame.t === 'state' &&
        (!frame.state.isStreaming || (frame.state.sessionName !== undefined &&
          frame.state.sessionName !== this.topicProjections.get(session.id)?.humanTitle)))) {
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
      listener.activityObservedAt = Date.now();
      listener.activitySuspect = false;
      listener.queuedMessages = frame.state.queuedMessageCount;
      listener.activity = this.options.store.hasPendingInitialTask(session.id) || frame.state.isStreaming || listener.queuedMessages > 0 ? 'running' : 'finished';
      void this.setTopicStatus(session, listener.activity);
    } else if (frame.t === 'event' && frame.event.type === 'agent_start') {
      listener.activityObservedAt = Date.now();
      listener.activity = 'running';
      void this.setTopicStatus(session, listener.activity);
    } else if (frame.t === 'event' && frame.event.type === 'agent_end') {
      listener.activitySuspect = true;
      listener.activity = listener.queuedMessages > 0 ? 'running' : 'finished';
      void this.setTopicStatus(session, listener.activity);
    }
    if (frame.t === 'error') {
      listener.activitySuspect = true;
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
            this.sendPrompt(listener,initial.content,initial.messageId);
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
      const images = typeof entry.content === 'string' ? undefined : entry.content.filter(part => part.type === 'image');
      const matchesContent = (prompt: PromptContent): boolean => prompt.text === content &&
        (images === undefined || (prompt.images?.length ?? 0) === images.length &&
          images.every((image,index) => image.data === prompt.images![index]!.data && image.mimeType === prompt.images![index]!.mimeType));
      const details = entry.details;
      if (details && typeof details === 'object' &&
          'from' in details && details.from === `Telegram @${this.bot.botInfo!.username}`) {
        const index = listener.pendingPrompts.findIndex(pending => matchesContent(pending.content));
        if (index !== -1) {
          const [pending] = listener.pendingPrompts.splice(index,1);
          pending!.observation.state = 'accepted; completion unknown';
          if (pending!.messageId !== undefined) {
            this.acknowledgeMessage(session,pending!.messageId,listener);
          }
        }
        if (listener.initial?.phase === 'sent' && matchesContent(listener.initial.content)) {
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
