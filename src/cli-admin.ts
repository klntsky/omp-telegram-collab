import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Command, CommanderError, Option } from 'commander';
import type { AppConfig } from '../shared/contracts.js';
import { Administration, one, promptMode, type Options } from './cli/administration.js';

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

export function registerAdminCommands(program: Command, configPath: () => string, dependencies: AdminDependencies = {}): () => void {
  let input: Interface | undefined;
  let muted = false;
  const question = dependencies.question ?? (async (prompt: string, hidden = false): Promise<string> => {
    if (!(dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) throw new Error('This operation requires an interactive terminal.');
    input ??= createInterface({ input: process.stdin, output: new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } }), terminal: true });
    try {
      const answer = input.question(prompt);
      muted = hidden;
      return await answer;
    }
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
  const create = program.command('create <path>').description('Register a project directory with a stable numeric ID');
  flag(create, '--id <id>', 'Explicit unused instance ID (default: maximum configured or persisted ID plus one)');
  create.action((path: string, _values, command: Command) => admin().create(path, one(options(command), 'id')));
  program.command('list').description('List registered project directories').action(() => { const service = admin(); service.show(service.load()); });
  program.command('show <id>').description('Show an instance and its chat assignments').action((id: string) => { const service = admin(); service.show(service.load(), id); });
  program.command('remove <id>').description('Remove an unassigned instance, retaining histories').action((id: string) => admin().remove(id));
  const chat = program.command('chat').description('Manage instance chat assignments');
  chat.command('list <id>').description('List an instance’s chat assignments').action((id: string) => { const service = admin(); service.show(service.load(), id); });
  const addChat = chat.command('add <id>').description('Connect or update a forum chat assignment');
  const removeChat = chat.command('remove <id>').description('Remove a chat assignment, retaining histories');
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
  flag(approve, '--instance <id>', 'Configured stable instance ID');
  flag(approve, '--yes', 'Confirm approval without prompting');
  policies(approve);
  approve.action((code: string, _values, command: Command) => {
    const values = options(command);
    const mode = one(values, 'all-messages-are-prompts');
    const proposals = one(values, 'users-can-propose-prompts');
    return admin().approve(code, one(values, 'path'), values.has('yes'), mode === undefined ? undefined : promptMode(mode), proposals === undefined ? undefined : promptMode(proposals, 'users-can-propose-prompts'), one(values, 'instance'));
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
