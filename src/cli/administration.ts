import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Api } from 'grammy';
import { z } from 'zod';
import type { AppConfig, BotConfig, InstanceConfig } from '../../shared/contracts.js';
import { canonicalPath, configWritable, defaultConfigPath, emptyConfig, findInstance, readConfig, writeConfig } from '../config.js';
import { Store } from '../store.js';
import type { AdminDependencies, AdminTelegram } from '../cli-admin.js';
import { notifyReload } from './reload.js';

export type Options = Map<string, string[]>;
export function one(options: Options, name: string): string | undefined {
  return options.get(name)?.[0];
}
function integer(value: string, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  return Number(value);
}
export function promptMode(value: string, flag = 'all-messages-are-prompts'): boolean {
  if (value !== 'true' && value !== 'false') throw new Error(`--${flag} must be true or false.`);
  return value === 'true';
}
const telegramRecord = z.record(z.unknown());
function record(value: unknown): Record<string, unknown> {
  const result = telegramRecord.safeParse(value);
  if (!result.success) throw new Error('Telegram returned an invalid response.');
  return result.data;
}

export class Administration {
  constructor(readonly path: string, readonly deps: AdminDependencies, readonly ask: (prompt: string, hidden?: boolean) => Promise<string>) {}
  get interactive(): boolean { return this.deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY); }
  print(text: string): void { (this.deps.output ?? (text => process.stdout.write(text)))(`${text}\n`); }
  load(allowCreate = false): AppConfig {
    if (!existsSync(this.path) && allowCreate) return emptyConfig(this.path);
    return readConfig(this.path);
  }
  writable(config: AppConfig): void {
    if (!configWritable(config.configPath)) throw new Error(`Configuration is read-only: ${config.configPath}. Both the file and its parent directory must be writable.`);
  }
  async save(config: AppConfig, previousDataDir = config.dataDir, afterWrite?: () => void | Promise<void>): Promise<void> {
    this.writable(config);
    writeConfig(config);
    try { await afterWrite?.(); }
    finally { await (this.deps.reload ?? notifyReload)(config, previousDataDir); }
  }
  api(bot: BotConfig): AdminTelegram {
    if (this.deps.telegram) return this.deps.telegram(bot.token);
    return new Api(bot.token);
  }
  instance(config: AppConfig, input: string): InstanceConfig {
    const id = integer(input, 'Instance ID');
    const instance = config.instances.find(instance => instance.id === id);
    if (!instance) throw new Error(`Instance ${id} is not configured.`);
    return instance;
  }
  nextId(config: AppConfig, store: Store, specified?: string): number {
    const used = new Set([...config.instances.map(instance => instance.id), ...store.listSessions().map(session => session.instanceId)]);
    let maximum = 0;
    for (const value of used) maximum = Math.max(maximum, value);
    const id = specified === undefined ? maximum + 1 : integer(specified, 'Instance ID');
    if (!Number.isSafeInteger(id)) throw new Error('No safe instance ID remains.');
    if (used.has(id)) throw new Error(`Instance ID ${id} is already configured or retained in history.`);
    return id;
  }
  async selectBot(config: AppConfig, value?: string): Promise<BotConfig> {
    if (value !== undefined) {
      const id = integer(value, 'Bot ID');
      const bot = config.bots.find(bot => bot.id === id);
      if (!bot) throw new Error(`Bot ${id} is not configured. Use bot add first.`);
      return bot;
    }
    if (config.bots.length === 1) return config.bots[0]!;
    if (!config.bots.length) throw new Error('No bots configured. Use bot add first.');
    if (!this.interactive) throw new Error('Multiple bots configured; specify --bot ID.');
    this.print(`Bots: ${config.bots.map(bot => bot.id).join(', ')}`);
    return this.selectBot(config, await this.ask('Bot ID: '));
  }
  async selectPromptMode(current: boolean | undefined, specified?: boolean): Promise<boolean> {
    const fallback = current ?? true;
    if (specified !== undefined) return specified;
    if (!this.interactive) return fallback;
    const answer = (await this.ask(`Treat all session-topic messages as prompts? true = ordinary messages, false = /p only [${fallback}]: `)).trim();
    return answer === '' ? fallback : promptMode(answer);
  }
  async selectProposalMode(current: boolean | undefined, specified?: boolean): Promise<boolean> {
    const fallback = current ?? false;
    if (specified !== undefined) return specified;
    if (!this.interactive) return fallback;
    const answer = (await this.ask(`Allow non-admin users to propose prompts for administrator approval? [${fallback}]: `)).trim();
    return answer === '' ? fallback : promptMode(answer, 'users-can-propose-prompts');
  }
  async verifyForum(bot: BotConfig, chatId: number): Promise<{chat: Record<string, unknown>; me: Record<string, unknown>}> {
    const me = record(await this.api(bot).getMe());
    if (me.id !== bot.id || me.is_bot !== true) throw new Error(`Configured token does not belong to bot ${bot.id}.`);
    const chat = record(await this.api(bot).getChat(chatId));
    if (chat.id !== chatId || chat.type !== 'supergroup' || chat.is_forum !== true) throw new Error('The chat must be a supergroup with Topics enabled.');
    const member = record(await this.api(bot).getChatMember(chatId, bot.id));
    if (member.status !== 'administrator' || member.can_manage_topics !== true || member.can_pin_messages !== true) throw new Error('Promote the bot to administrator with Manage Topics and Pin Messages permissions.');
    return {chat, me};
  }
  async requesterAdmin(bot: BotConfig, chatId: number, userId: number): Promise<void> {
    const member = record(await this.api(bot).getChatMember(chatId, userId));
    const user = record(member.user);
    if (user.id !== userId || user.is_bot === true || !['creator', 'administrator'].includes(String(member.status))) throw new Error('The requester is no longer a current group administrator. Request preserved.');
  }
  historySafe(config: AppConfig, store: Store, instanceId: number, botId: number, chatId: number): void {
    const current = findInstance(config, botId, chatId);
    if (current && current.instance.id !== instanceId) throw new Error(`This bot/chat is already assigned to instance ${current.instance.id}. Remove that assignment first.`);
    for (const session of store.listSessions(botId)) {
      if (session.chatId === chatId && session.instanceId !== instanceId) throw new Error('This bot/chat has histories pinned to a different logical instance. It cannot be reassigned safely.');
    }
  }
  async create(input: string, specifiedId?: string): Promise<void> {
    const defaultDir = canonicalPath(input);
    const config = this.load(true);
    this.writable(config);
    const store = new Store(join(config.dataDir, 'telegram.sqlite'));
    try {
      const id = this.nextId(config, store, specifiedId);
      config.instances.push({id, defaultDir, chats: []});
      await this.save(config);
      this.print(`Created instance ${id}: ${defaultDir}`);
    } finally { store.close(); }
  }
  show(config: AppConfig, input?: string): void {
    const entries = input === undefined ? config.instances : [this.instance(config, input)];
    if (!entries.length) { this.print('No instances configured.'); return; }
    for (const instance of entries) this.print(`${instance.id}\t${instance.defaultDir}\n  chats: ${instance.chats.map(chat => `${chat.chatId} (bot ${chat.botId}, all_messages_are_prompts: ${chat.all_messages_are_prompts ?? true}, users_can_propose_prompts: ${chat.users_can_propose_prompts ?? false})`).join(', ') || '(none)'}`);
  }
  async addChat(input: string, chatValue: string, botValue?: string, specifiedMode?: boolean, specifiedProposals?: boolean): Promise<void> {
    const config = this.load();
    this.writable(config);
    const instance = this.instance(config, input);
    const path = instance.defaultDir;
    const bot = await this.selectBot(config, botValue);
    const chatId = integer(chatValue, 'Chat ID', Number.MIN_SAFE_INTEGER, -1);
    const store = new Store(join(config.dataDir, 'telegram.sqlite'));
    try {
      this.historySafe(config, store, instance.id, bot.id, chatId);
      const {chat, me} = await this.verifyForum(bot, chatId);
      const assignment = instance.chats.find(value => value.botId === bot.id && value.chatId === chatId);
      const all_messages_are_prompts = await this.selectPromptMode(assignment?.all_messages_are_prompts, specifiedMode);
      const users_can_propose_prompts = await this.selectProposalMode(assignment?.users_can_propose_prompts, specifiedProposals);
      if (assignment) Object.assign(assignment, {all_messages_are_prompts, users_can_propose_prompts});
      else instance.chats.push({botId: bot.id, chatId, all_messages_are_prompts, users_can_propose_prompts});
      await this.save(config, config.dataDir, () => store.enrollGroup(bot.id, chatId));
      this.print(`Connected ${String(chat.title ?? chatId)} (${chatId}) through @${String(me.username ?? bot.id)} (${bot.id}) to ${path}.`);
    } finally { store.close(); }
  }
  async approve(code: string, input: string | undefined, yes: boolean, specifiedMode?: boolean, specifiedProposals?: boolean, instanceValue?: string): Promise<void> {
    const config = this.load();
    this.writable(config);
    if (!this.interactive && !yes) throw new Error('Noninteractive approval requires --yes and --instance ID or --path PATH.');
    const store = new Store(join(config.dataDir, 'telegram.sqlite'));
    try {
      const pending = store.getSetupRequest(code);
      if (!pending) throw new Error('Setup request not found or expired. Ask the group administrator to run /setup again.');
      const bot = await this.selectBot(config, String(pending.botId));
      const {chat, me} = await this.verifyForum(bot, pending.chatId);
      await this.requesterAdmin(bot, pending.chatId, pending.userId);
      this.print(`Verified bot @${String(me.username ?? bot.id)} (${bot.id})\nVerified forum ${String(chat.title ?? pending.chatId)} (${pending.chatId})\nVerified requester ${pending.userId}, current group administrator.`);
      if (input !== undefined && instanceValue !== undefined) throw new Error('Choose --instance ID or --path PATH, not both.');
      let target = instanceValue ?? input;
      if (!target && this.interactive) {
        this.show(config);
        target = await this.ask('Instance ID or project directory where OMP will run: ');
      }
      if (!target) throw new Error('Approval requires --instance ID or --path PATH.');
      let instance: InstanceConfig;
      if (instanceValue !== undefined || (input === undefined && /^[1-9]\d*$/.test(target))) instance = this.instance(config, target);
      else {
        const defaultDir = canonicalPath(target);
        const current = findInstance(config, bot.id, pending.chatId)?.instance;
        if (current && current.defaultDir !== defaultDir) throw new Error(`This bot/chat is already assigned to instance ${current.id} with a different default directory. Use --instance ID to select it.`);
        instance = current ?? {id: this.nextId(config, store), defaultDir, chats: []};
      }
      const path = instance.defaultDir;
      this.historySafe(config, store, instance.id, bot.id, pending.chatId);
      const assignment = instance.chats.find(value => value.botId === bot.id && value.chatId === pending.chatId);
      const all_messages_are_prompts = specifiedMode ?? assignment?.all_messages_are_prompts ?? true;
      const users_can_propose_prompts = specifiedProposals ?? assignment?.users_can_propose_prompts ?? false;
      this.print(`Project directory where OMP will run: ${path}\nThe agent will have the service account's filesystem and credential access on the agent's computer.`);
      if (!yes && !/^(y|yes)$/i.test((await this.ask(`Connect this forum to ${path}? [y/N] `)).trim())) { this.print('Approval cancelled; request preserved.'); return; }
      await this.verifyForum(bot, pending.chatId);
      await this.requesterAdmin(bot, pending.chatId, pending.userId);
      if (!store.getSetupRequest(code)) throw new Error('Setup request expired during approval. Ask the administrator to run /setup again.');
      if (assignment) Object.assign(assignment, {all_messages_are_prompts, users_can_propose_prompts});
      else instance.chats.push({botId: bot.id, chatId: pending.chatId, all_messages_are_prompts, users_can_propose_prompts});
      if (!config.instances.includes(instance)) config.instances.push(instance);
      await this.save(config, config.dataDir, () => {
        store.enrollGroup(bot.id, pending.chatId);
        store.consumeSetupRequest(code);
      });
      await this.api(bot).sendMessage(pending.chatId, 'Setup approved. This forum is connected to OMP. Use /settings to choose prompt permissions and the session limit. Send /new <task> to start a coding session.');
      this.print(`Approved ${code}: ${path}`);
    } finally { store.close(); }
  }
  async botAdd(options: Options): Promise<void> {
    const config = this.load(true);
    this.writable(config);
    const envName = one(options, 'token-env');
    if (envName && options.has('token-stdin')) throw new Error('Choose --token-env or --token-stdin, not both.');
    let token: string;
    if (envName) {
      const value = (this.deps.environment ?? process.env)[envName];
      if (!value) throw new Error('The selected token environment variable is empty.');
      token = value.trim();
    } else if (options.has('token-stdin')) {
      token = (await (this.deps.readToken ?? readTokenStdin)()).trim();
    } else {
      if (!this.interactive) throw new Error('Use --token-stdin or --token-env VARIABLE for noninteractive bot add.');
      token = (await this.ask('Bot token (hidden): ', true)).trim();
    }
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Telegram bot token.');
    const candidate: BotConfig = {id: integer(token.split(':')[0]!, 'Bot ID'), token};
    if (config.publicUrl) {
      candidate.miniAppShortName = one(options, 'mini-app-short-name') ?? (this.interactive ? (await this.ask('BotFather Mini App short name [app]: ')).trim() || 'app' : 'app');
      if (!/^[A-Za-z0-9_]+$/.test(candidate.miniAppShortName)) throw new Error('Mini App short name must use only letters, numbers, or underscores.');
    }
    if (config.bots.some(bot => bot.id === candidate.id)) throw new Error(`Bot ${candidate.id} is already configured. Remove it before replacing its credentials.`);
    const me = record(await this.api(candidate).getMe());
    if (me.id !== candidate.id || me.is_bot !== true) throw new Error('Telegram token identity did not match the bot ID.');
    config.bots.push(candidate);
    await this.save(config);
    this.print(`Added @${String(me.username ?? candidate.id)} (${candidate.id})${candidate.miniAppShortName ? `, Mini App ${candidate.miniAppShortName}` : ''}.`);
  }
  async setup(options: Options): Promise<void> {
    const config = this.load(true);
    this.writable(config);
    const previousDataDir = config.dataDir;
    const interactive = options.size === 0;
    if (interactive && !this.interactive) throw new Error('Setup requires service setting options or an interactive terminal.');
    const value = async (flag: string, label: string, current: string): Promise<string> => {
      const specified = one(options, flag);
      if (specified !== undefined) return specified;
      return interactive ? (await this.ask(`${label} [${current}]: `)).trim() || current : current;
    };
    if (interactive) {
      this.print('The optional Mini App provides a live transcript, tool details, and subagent activity. It is read-only. It requires a public HTTPS origin and a BotFather Mini App for each bot. Telegram-only mode needs neither.');
      const answer = (await this.ask(`Enable Mini App? [${config.publicUrl ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      if (answer && !['y', 'yes', 'n', 'no'].includes(answer)) throw new Error('Answer yes or no to enable Mini App.');
      const enabled = answer ? ['y', 'yes'].includes(answer) : config.publicUrl !== '';
      config.publicUrl = enabled ? await value('public-url', 'Public HTTPS origin', config.publicUrl) : '';
      if (enabled && !config.publicUrl) throw new Error('Mini App requires a public HTTPS origin.');
    } else config.publicUrl = await value('public-url', 'Public HTTPS origin', config.publicUrl);
    if (config.publicUrl) {
      for (const bot of config.bots) bot.miniAppShortName ??= 'app';
    }
    if (config.publicUrl) {
      config.host = await value('host', 'Listen host', config.host);
      config.port = integer(await value('port', 'Listen port', String(config.port)), 'Port', 0, 65535);
    } else {
      if (options.has('host')) config.host = one(options, 'host')!;
      if (options.has('port')) config.port = integer(one(options, 'port')!, 'Port', 0, 65535);
    }
    config.dataDir = resolve(await value('data-dir', 'Data directory (existing histories stay in their current directory)', config.dataDir));
    const executable = await value('omp-executable', 'OMP executable', config.omp.executable);
    config.omp.executable = executable.includes('/') ? resolve(executable) : executable;
    if (interactive) {
      const args = await value('omp-args', 'OMP arguments as a JSON array of literal strings', JSON.stringify(config.omp.args));
      let parsed: unknown;
      try { parsed = JSON.parse(args); } catch { throw new Error('OMP arguments must be a JSON array of strings.'); }
      if (!Array.isArray(parsed) || !parsed.every(arg => typeof arg === 'string')) throw new Error('OMP arguments must be a JSON array of strings.');
      config.omp.args = parsed;
    } else if (options.has('omp-arg') || options.has('clear-omp-args')) config.omp.args = options.get('omp-arg') ?? [];
    if (options.has('max-sessions')) config.omp.maxSessions = integer(one(options, 'max-sessions')!, 'Maximum sessions');
    config.omp.startupTimeoutMs = integer(await value('startup-timeout-ms', 'OMP startup timeout in milliseconds', String(config.omp.startupTimeoutMs)), 'Startup timeout');
    const relay = await value('relay-url', 'OMP relay URL (enter - to clear)', config.omp.relayUrl ?? '');
    if (relay === '-' || relay === '') delete config.omp.relayUrl;
    else config.omp.relayUrl = relay;
    await this.save(config, previousDataDir);
    this.print(`Service configuration saved to ${config.configPath}.`);
    const configOption = config.configPath === defaultConfigPath() ? '' : ` --config '${config.configPath.replaceAll("'", "'\\''")}'`;
    this.print(config.bots.length
      ? `Next on the agent's computer: run omp-telegram-collab${configOption} start. Leave it running. In Telegram, add the bot to your forum and send /setup.`
      : `Next on the agent's computer: run omp-telegram-collab${configOption} bot add, then omp-telegram-collab${configOption} start. Leave it running. In Telegram, add the bot to your forum and send /setup.`);
  }
  async remove(input: string): Promise<void> {
    const config = this.load(); this.writable(config);
    const instance = this.instance(config, input);
    if (instance.chats.length) throw new Error('Remove this instance’s chat assignments before removing the instance.');
    config.instances = config.instances.filter(value => value.id !== instance.id);
    await this.save(config); this.print(`Removed instance ${instance.id}. Histories were retained.`);
  }
  async removeChat(input: string, options: Options): Promise<void> {
    const chat = one(options, 'chat'); if (!chat) throw new Error('Specify --chat ID.');
    const config = this.load(); this.writable(config); const instance = this.instance(config, input);
    const bot = await this.selectBot(config, one(options, 'bot')); const chatId = integer(chat, 'Chat ID', Number.MIN_SAFE_INTEGER, -1);
    instance.chats = instance.chats.filter(item => item.botId !== bot.id || item.chatId !== chatId);
    await this.save(config); this.print('Chat assignment removed. Histories were retained.');
  }
  listBots(): void {
    const config = this.load();
    for (const bot of config.bots) this.print(`${bot.id}\t${config.publicUrl ? `Mini App: ${bot.miniAppShortName}` : 'Telegram-only'}`);
    if (!config.bots.length) this.print('No bots configured.');
  }
  async removeBot(id: string): Promise<void> {
    const config = this.load(); this.writable(config);
    const bot = await this.selectBot(config, id); config.bots = config.bots.filter(item => item.id !== bot.id);
    for (const instance of config.instances) instance.chats = instance.chats.filter(chat => chat.botId !== bot.id);
    await this.save(config); this.print(`Removed bot ${bot.id} and its chat assignments. Histories were retained.`);
  }
}

async function readTokenStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}
