import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { AppConfig, InstanceConfig } from '../shared/contracts.js';
import { isMentionableSkillName } from './skill-commands.js';

export class ConfigError extends Error {
  constructor(readonly keys: readonly string[], detail: string) {
    super(`Configuration error in ${keys.join(', ')}: ${detail}`);
    this.name = 'ConfigError';
  }
}

const tokenPattern = /^[1-9]\d*:[A-Za-z0-9_-]+$/;
const literal = z.string().refine(value => !value.includes('\0'));
const nonempty = literal.refine(value => value.trim().length > 0);
const positiveInteger = z.number().int().safe().positive();
const absolutePath = nonempty.refine(value => isAbsolute(value) && normalize(value) === value);
const publicUrlSchema = z.string().refine(value => {
  if (value === '') return true;
  if (!/^https:\/\/[^/?#\\@]+\/?$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}).transform(value => value ? new URL(value).origin : '');
const relayUrlSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !value.includes('#');
  } catch { return false; }
});
const forbiddenArgs: Record<string, true> = {
  '--session': true, '-s': true, '--session-dir': true, '--resume': true, '-r': true,
  '--continue': true, '-c': true, '--no-session': true, '--restore': true, '--fork': true,
  '--mode': true, '--print': true, '-p': true, '--goal': true, '--cwd': true,
  '--help': true, '-h': true, '--version': true,
};
const argumentSchema = literal.refine(value => {
  const flag = value.split('=', 1)[0]!;
  return !Object.hasOwn(forbiddenArgs, flag) && !flag.startsWith('--from-');
});
const configSchema = z.object({
  version: z.literal(1).optional(),
  terminated: z.boolean().optional(),
  bots: z.array(z.object({
    id: positiveInteger,
    token: z.string().regex(tokenPattern),
    miniAppShortName: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
  }).strict().refine(bot => Number(bot.token.split(':')[0]) === bot.id)),
  instances: z.record(absolutePath, z.object({
    chats: z.array(z.object({
      botId: positiveInteger,
      chatId: z.number().int().safe().refine(value => value !== 0),
      all_messages_are_prompts: z.boolean().default(true),
      users_can_propose_prompts: z.boolean().default(false),
      default_model_preset: z.string().regex(/^[A-Za-z][\w-]*$/).optional(),
      default_new_topic_skill: z.string().refine(isMentionableSkillName).optional(),
    }).strict()),
  }).strict()),
  publicUrl: publicUrlSchema,
  host: nonempty,
  port: z.number().int().min(0).max(65535),
  dataDir: absolutePath,
  omp: z.object({
    executable: nonempty.refine(value => !value.includes('/') || isAbsolute(value)),
    args: z.array(argumentSchema),
    maxSessions: positiveInteger,
    startupTimeoutMs: positiveInteger,
    relayUrl: relayUrlSchema.optional(),
  }).strict(),
}).strict();

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function failure(path: string, keys: string[], detail: string): ConfigError {
  return new ConfigError(keys, `${detail} Configuration file: ${path}`);
}

function validate(value: unknown, configPath: string): AppConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map(issue => issue.path.join('.') || 'config'))];
    throw failure(configPath, keys, 'Invalid configuration fields; check types, paths, bot credentials, URLs, and runtime settings.');
  }
  const { version: _version, ...config } = result.data;
  const ids = new Set<number>();
  const tokens = new Set<string>();
  for (const bot of config.bots) {
    if (config.publicUrl && !bot.miniAppShortName) throw failure(configPath, ['bots'], 'Every bot requires a Mini App short name when a public HTTPS origin is configured.');
    if (ids.has(bot.id) || tokens.has(bot.token)) throw failure(configPath, ['bots'], 'Every bot must have a distinct ID and token.');
    ids.add(bot.id);
    tokens.add(bot.token);
  }
  const assignments = new Set<string>();
  for (const instance of Object.values(config.instances)) {
    for (const chat of instance.chats) {
      const key = `${chat.botId}:${chat.chatId}`;
      if (!ids.has(chat.botId)) throw failure(configPath, ['instances'], 'Every chat assignment must refer to a configured bot.');
      if (assignments.has(key)) throw failure(configPath, ['instances'], 'Each bot/chat pair can be assigned only once.');
      assignments.add(key);
    }
  }
  return { ...config, configPath };
}

export function defaultConfigPath(): string {
  return resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'omp-telegram', 'config.yaml');
}

export function canonicalPath(input: string): string {
  try {
    const path = realpathSync(resolve(input));
    if (!statSync(path).isDirectory()) throw new Error();
    return path;
  } catch { throw new ConfigError(['path'], 'Choose an existing accessible directory.'); }
}

export function emptyConfig(configPath: string): AppConfig {
  const path = resolve(configPath);
  return {
    bots: [], instances: {}, publicUrl: '', host: '127.0.0.1', port: 3000,
    dataDir: join(dirname(path), 'data'), configPath: path,
    omp: { executable: 'omp', args: [], maxSessions: 8, startupTimeoutMs: 60000 },
  };
}

export function readConfig(input: string): AppConfig {
  const path = resolve(input);
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: string;
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      source = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw failure(path, ['config'], 'Invalid YAML (including duplicate mapping keys).');
    return validate(document.toJS({ maxAliasCount: 100 }), path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw failure(path, ['config'], 'Cannot read a regular, non-symlink YAML configuration file.');
  }
}

const terminationStats = new WeakMap<AppConfig, Stats>();

export function refreshTermination(config: AppConfig): boolean {
  const current = lstatSync(config.configPath);
  const previous = terminationStats.get(config);
  if (!previous || !sameFile(previous, current) || previous.ctimeMs !== current.ctimeMs) {
    const fresh = readConfig(config.configPath);
    if (fresh.terminated === undefined) delete config.terminated;
    else config.terminated = fresh.terminated;
    terminationStats.set(config, current);
  }
  return config.terminated === true;
}

function modeAllows(stat: Stats, write: boolean): boolean {
  const uid = process.geteuid?.();
  const groups = process.getgroups?.() ?? [];
  const bit = write ? 2 : 1;
  if (uid === 0) return Boolean(stat.mode & (write ? 0o222 : 0o111));
  const shift = uid === stat.uid ? 6 : (groups.includes(stat.gid) || process.getegid?.() === stat.gid) ? 3 : 0;
  return Boolean(stat.mode & (bit << shift));
}

function writableState(path: string): { file?: Stats; parent: Stats; parentPath: string } {
  let file: Stats | undefined;
  try { file = lstatSync(path); } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
  if (file && (!file.isFile() || file.isSymbolicLink() || !modeAllows(file, true))) throw new Error();
  if (file) accessSync(path, constants.W_OK);
  let parentPath = dirname(path);
  while (!existsSync(parentPath)) {
    const ancestor = dirname(parentPath);
    if (ancestor === parentPath) throw new Error();
    parentPath = ancestor;
  }
  const parent = lstatSync(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !modeAllows(parent, true) || !modeAllows(parent, false)) throw new Error();
  accessSync(parentPath, constants.W_OK | constants.X_OK);
  for (let ancestor = dirname(parentPath); ; ancestor = dirname(ancestor)) {
    const stat = statSync(ancestor);
    if (!stat.isDirectory() || !modeAllows(stat, false)) throw new Error();
    accessSync(ancestor, constants.X_OK);
    if (ancestor === dirname(ancestor)) break;
  }
  return { ...(file ? { file } : {}), parent, parentPath };
}

export function configWritable(input: string): boolean {
  try { writableState(resolve(input)); return true; } catch { return false; }
}

function sameFile(left: Stats | undefined, right: Stats | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.ino === right.ino && left.dev === right.dev && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export function writeConfig(config: AppConfig): void {
  const path = resolve(config.configPath);
  const { configPath: _configPath, ...input } = config;
  const checked = validate(input, path);
  const { configPath: _checkedPath, ...document } = checked;
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const initial = writableState(path);
    const registered = initial.file ? readConfig(path).instances : {};
    for (const directory of Object.keys(checked.instances)) {
      if (Object.hasOwn(registered, directory)) continue;
      try {
        if (canonicalPath(directory) !== directory) throw new Error();
      } catch { throw failure(path, ['instances'], 'New instance paths must be existing canonical directories.'); }
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const before = writableState(path);
    if (!sameFile(initial.file, before.file)) throw new Error();
    const parentPath = realpathSync(dirname(path));
    temporary = join(dirname(path), `.${randomBytes(16).toString('hex')}.tmp`);
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, stringify({ version: 1, ...document }), 'utf8');
    if (before.file) {
      const temp = fstatSync(fd);
      if (temp.uid !== before.file.uid || temp.gid !== before.file.gid) fchownSync(fd, before.file.uid, before.file.gid);
      fchmodSync(fd, before.file.mode & 0o7777);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const after = writableState(path);
    if (!sameFile(before.file, after.file) || before.parent.dev !== after.parent.dev || before.parent.ino !== after.parent.ino || parentPath !== realpathSync(dirname(path))) throw new Error();
    if (!before.file) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    temporary = undefined;
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw failure(path, ['config'], 'Cannot write configuration; the file and parent directory must both be writable and unchanged.');
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch (error) { if (!errno(error, 'ENOENT')) throw failure(path, ['config'], 'Cannot remove temporary configuration file.'); }
    }
  }
}

export function validateStart(config: AppConfig): void {
  const { configPath, ...value } = config;
  const checked = validate(value, configPath);
  if (!checked.bots.length) throw failure(configPath, ['bots'], 'Configure at least one bot before starting.');
}

export function findInstance(config: AppConfig, botId: number, chatId: number): { path: string; instance: InstanceConfig } | undefined {
  for (const [path, instance] of Object.entries(config.instances)) {
    if (instance.chats.some(chat => chat.botId === botId && chat.chatId === chatId)) return { path, instance };
  }
  return undefined;
}
