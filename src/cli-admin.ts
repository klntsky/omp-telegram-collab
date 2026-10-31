import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { request } from 'node:http';
import { Api } from 'grammy';
import { Command, CommanderError, Option } from 'commander';
import { z } from 'zod';
import type { AppConfig, BotConfig, InstanceConfig } from '../shared/contracts.js';
import { canonicalPath, configWritable, defaultConfigPath, emptyConfig, findInstance, readConfig, writeConfig } from './config.js';
import { Store } from './store.js';

export interface AdminTelegram {
  getMe(): Promise<unknown>;
  getChat(chatId: number): Promise<unknown>;
  getChatMember(chatId: number, userId: number): Promise<unknown>;
  sendMessage(chatId: number, text: string): Promise<unknown>;
}
export interface AdminDependencies {
  interactive?: boolean;
  question?: (prompt: string, hidden?: boolean) => Promise<string>;
  output?: (text: string) => void;
  telegram?: (token: string) => AdminTelegram;
  environment?: NodeJS.ProcessEnv;
  readToken?: () => Promise<string>;
  reload?: (config: AppConfig, socketDataDir: string) => Promise<void>;
}

export async function notifyReload(config: AppConfig, socketDataDir = config.dataDir): Promise<void> {
  const {promise, resolve: acknowledge, reject} = Promise.withResolvers<void>();
  const failure = () => new Error('Configuration saved, but the running service did not apply it. Check service logs and run reload.');
  const req = request({ socketPath: join(socketDataDir, 'control.sock'), path: '/reload', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { if (body.length < 8192) body += chunk; });
    response.on('error', () => reject(failure()));
    response.on('aborted', () => reject(failure()));
    response.on('end', () => {
      if (response.statusCode === 200) {
        try {
          const result: unknown = JSON.parse(body);
          if (result && typeof result === 'object' && 'ok' in result && result.ok === true) { acknowledge(); return; }
        } catch { reject(failure()); return; }
      }
      reject(failure());
    });
  });
  const timer = setTimeout(() => req.destroy(failure()), 5000);
  req.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') acknowledge();
    else reject(failure());
  });
  req.end(JSON.stringify({ configPath: config.configPath }));
  try { await promise; } finally { clearTimeout(timer); req.destroy(); }
}

type Options = Map<string, string[]>;
function one(options: Options, name: string): string | undefined {
  return options.get(name)?.[0];
}
function integer(value: string, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  return Number(value);
}
function promptMode(value: string, flag = 'all-messages-are-prompts'): boolean {
  if (value !== 'true' && value !== 'false') throw new Error(`--${flag} must be true or false.`);
  return value === 'true';
}
const telegramRecord = z.record(z.unknown());
function record(value: unknown): Record<string, unknown> {
  const result = telegramRecord.safeParse(value);
  if (!result.success) throw new Error('Telegram returned an invalid response.');
  return result.data;
}

class Administration {
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
  instance(config: AppConfig, input: string): {path: string; instance: InstanceConfig} {
    const literal = resolve(input);
    const path = Object.hasOwn(config.instances, literal) ? literal : canonicalPath(input);
    const instance = config.instances[path];
    if (!instance) throw new Error(`No instance registered for ${path}. Use create PATH first.`);
    return {path, instance};
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
  historySafe(config: AppConfig, store: Store, path: string, botId: number, chatId: number): void {
    const current = findInstance(config, botId, chatId);
    if (current && current.path !== path) throw new Error(`This bot/chat is already assigned to ${current.path}. Remove that assignment first.`);
    for (const session of store.listSessions(botId)) {
      if (session.chatId !== chatId) continue;
      if (session.instancePath !== path || canonicalPath(session.instancePath) !== session.instancePath) throw new Error('This bot/chat has histories pinned to a different or unknown directory. It cannot be reassigned safely.');
    }
  }
  async create(input: string): Promise<void> {
    const path = canonicalPath(input);
    const config = this.load(true);
    this.writable(config);
    if (config.instances[path]) throw new Error(`Instance already registered: ${path}`);
    config.instances[path] = {chats: []};
    await this.save(config);
    this.print(`Created ${path}`);
  }
  show(config: AppConfig, input?: string): void {
    const entries = input === undefined ? Object.entries(config.instances) : (() => { const found = this.instance(config, input); return [[found.path, found.instance] as const]; })();
    if (!entries.length) { this.print('No instances configured.'); return; }
    for (const [path, instance] of entries) this.print(`${path}\n  chats: ${instance.chats.map(chat => `${chat.chatId} (bot ${chat.botId}, all_messages_are_prompts: ${chat.all_messages_are_prompts ?? true}, users_can_propose_prompts: ${chat.users_can_propose_prompts ?? false})`).join(', ') || '(none)'}`);
  }
  async addChat(input: string, chatValue: string, botValue?: string, specifiedMode?: boolean, specifiedProposals?: boolean): Promise<void> {
    const config = this.load();
    this.writable(config);
    const {path, instance} = this.instance(config, input);
    if (canonicalPath(path) !== path) throw new Error('The registered directory now resolves to another path. Remove the old instance and explicitly register the new canonical directory.');
    const bot = await this.selectBot(config, botValue);
    const chatId = integer(chatValue, 'Chat ID', Number.MIN_SAFE_INTEGER, -1);
    const store = new Store(join(config.dataDir, 'telegram.sqlite'));
    try {
      this.historySafe(config, store, path, bot.id, chatId);
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
  async approve(code: string, input: string | undefined, yes: boolean, specifiedMode?: boolean, specifiedProposals?: boolean): Promise<void> {
    const config = this.load();
    this.writable(config);
    if (!this.interactive && !yes) throw new Error('Noninteractive approval requires --yes and --path PATH.');
    const store = new Store(join(config.dataDir, 'telegram.sqlite'));
    try {
      const pending = store.getSetupRequest(code);
      if (!pending) throw new Error('Setup request not found or expired. Ask the group administrator to run /setup again.');
      const bot = await this.selectBot(config, String(pending.botId));
      const {chat, me} = await this.verifyForum(bot, pending.chatId);
      await this.requesterAdmin(bot, pending.chatId, pending.userId);
      this.print(`Verified bot @${String(me.username ?? bot.id)} (${bot.id})\nVerified forum ${String(chat.title ?? pending.chatId)} (${pending.chatId})\nVerified requester ${pending.userId}, current group administrator.`);
      let target = input;
      if (!target && this.interactive) {
        this.show(config);
        target = await this.ask('Project directory where OMP will run: ');
      }
      if (!target) throw new Error('Approval requires --path PATH.');
      const path = canonicalPath(target);
      this.historySafe(config, store, path, bot.id, pending.chatId);
      const instance = config.instances[path] ?? {chats: []};
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
      config.instances[path] = instance;
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
      this.print('The optional Mini App provides a live transcript, tool details, and subagent controls. It requires a public HTTPS origin and a BotFather Mini App for each bot. Telegram-only mode needs neither.');
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
    const {path, instance} = this.instance(config, input);
    if (instance.chats.length) throw new Error('Remove this instance’s chat assignments before removing the instance.');
    delete config.instances[path];
    await this.save(config); this.print(`Removed ${path}. Histories were retained.`);
  }
  async removeChat(input: string, options: Options): Promise<void> {
    const chat = one(options, 'chat'); if (!chat) throw new Error('Specify --chat ID.');
    const config = this.load(); this.writable(config); const {instance} = this.instance(config, input);
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
    for (const instance of Object.values(config.instances)) instance.chats = instance.chats.filter(chat => chat.botId !== bot.id);
    await this.save(config); this.print(`Removed bot ${bot.id} and its chat assignments. Histories were retained.`);
  }
}

async function readTokenStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

export function registerAdminCommands(program: Command, configPath: () => string, dependencies: AdminDependencies = {}): () => void {
  let input: Interface | undefined;
  let muted = false;
  const question = dependencies.question ?? (async (prompt: string, hidden = false): Promise<string> => {
    if (!(dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) throw new Error('This operation requires an interactive terminal.');
    input ??= createInterface({ input: process.stdin, output: new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } }), terminal: true });
    process.stdout.write(prompt);
    muted = hidden;
    try { return await input.question(''); }
    finally { muted = false; if (hidden) process.stdout.write('\n'); }
  });
  const admin = (): Administration => new Administration(resolve(configPath()), dependencies, question);
  const options = (command: Command): Options => {
    const values = command.opts<Record<string, string[]>>();
    return new Map(command.options.flatMap(option => {
      const value = values[option.attributeName()];
      return value === undefined ? [] : [[option.name(), value] as const];
    }));
  };
  const flag = (command: Command, flags: string, description: string, repeat = false): void => {
    const option = new Option(flags, description);
    option.argParser((value: string, previous: string[] | undefined): string[] => {
      if (previous && !repeat) throw new Error(`Use --${option.name()} only once.`);
      return [...(previous ?? []), value ?? 'true'];
    });
    command.addOption(option);
  };
  const policies = (command: Command): void => {
    flag(command, '--all-messages-are-prompts <true|false>', 'Treat ordinary topic messages as prompts');
    flag(command, '--users-can-propose-prompts <true|false>', 'Allow non-admin prompt proposals');
  };
  const setup = program.command('setup').description('Configure service and OMP settings');
  for (const [flags, description] of [
    ['--public-url <url>', 'Public HTTPS origin for the optional Mini App'],
    ['--host <host>', 'Service listen host'],
    ['--port <port>', 'Service listen port'],
    ['--data-dir <path>', 'Service data directory'],
    ['--omp-executable <file>', 'OMP executable'],
    ['--omp-arg <arg>', 'Literal OMP argument (repeatable, including values starting with --)'],
    ['--max-sessions <n>', 'Maximum simultaneous OMP sessions'],
    ['--startup-timeout-ms <n>', 'OMP startup timeout in milliseconds'],
    ['--relay-url <url>', 'OMP relay URL, or - to clear'],
    ['--clear-omp-args', 'Clear configured OMP arguments'],
  ] as const) flag(setup, flags, description, flags === '--omp-arg <arg>');
  setup.action((_values, command: Command) => admin().setup(options(command)));
  program.command('create <path>').description('Register a project directory').action((path: string) => admin().create(path));
  program.command('list').description('List registered project directories').action(() => { const service = admin(); service.show(service.load()); });
  program.command('show <path>').description('Show a project and its chat assignments').action((path: string) => { const service = admin(); service.show(service.load(), path); });
  program.command('remove <path>').description('Remove an unassigned project, retaining histories').action((path: string) => admin().remove(path));
  const chat = program.command('chat').description('Manage project chat assignments');
  chat.command('list <path>').description('List a project’s chat assignments').action((path: string) => { const service = admin(); service.show(service.load(), path); });
  const addChat = chat.command('add <path>').description('Connect or update a forum chat assignment');
  const removeChat = chat.command('remove <path>').description('Remove a chat assignment, retaining histories');
  for (const command of [addChat, removeChat]) {
    flag(command, '--chat <id>', 'Telegram forum chat ID');
    flag(command, '--bot <id>', 'Configured bot ID');
  }
  policies(addChat);
  addChat.action((path: string, _values, command: Command) => {
    const values = options(command);
    const chatId = one(values, 'chat'); if (!chatId) throw new Error('Specify --chat ID.');
    const mode = one(values, 'all-messages-are-prompts');
    const proposals = one(values, 'users-can-propose-prompts');
    return admin().addChat(path, chatId, one(values, 'bot'), mode === undefined ? undefined : promptMode(mode), proposals === undefined ? undefined : promptMode(proposals, 'users-can-propose-prompts'));
  });
  removeChat.action((path: string, _values, command: Command) => admin().removeChat(path, options(command)));
  const approve = program.command('approve <code>').description('Approve a Telegram setup request');
  flag(approve, '--path <path>', 'Project directory where OMP will run');
  flag(approve, '--yes', 'Confirm approval without prompting');
  policies(approve);
  approve.action((code: string, _values, command: Command) => {
    const values = options(command);
    const mode = one(values, 'all-messages-are-prompts');
    const proposals = one(values, 'users-can-propose-prompts');
    return admin().approve(code, one(values, 'path'), values.has('yes'), mode === undefined ? undefined : promptMode(mode), proposals === undefined ? undefined : promptMode(proposals, 'users-can-propose-prompts'));
  });
  const bot = program.command('bot').description('Manage Telegram bot credentials');
  const addBot = bot.command('add').description('Verify and register a Telegram bot');
  flag(addBot, '--token-env <variable>', 'Read the token from an environment variable');
  flag(addBot, '--token-stdin', 'Read the token from standard input');
  flag(addBot, '--mini-app-short-name <name>', 'BotFather Mini App short name');
  addBot.action((_values, command: Command) => admin().botAdd(options(command)));
  bot.command('list').description('List configured bots').action(() => admin().listBots());
  bot.command('remove <id>').description('Remove a bot and its assignments, retaining histories').action((id: string) => admin().removeBot(id));
  return () => input?.close();
}

export async function runAdmin(argv: string[], configPath: string, dependencies: AdminDependencies = {}): Promise<boolean> {
  const program = new Command().name('omp-telegram-collab').exitOverride().configureOutput({ writeErr: () => {} });
  const cleanup = registerAdminCommands(program, () => configPath, dependencies);
  if (!program.commands.some(command => command.name() === argv[0]) && argv[0] !== '--help' && argv[0] !== '-h' && argv[0] !== 'help') return false;
  try {
    await program.parseAsync(argv, {from: 'user'});
    return true;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return true;
    throw error;
  } finally { cleanup(); }
}
