import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { combineTelegramErrors } from '../../test/e2e/helpers/errors.js';
import { withTelegramTestLock } from './telegram-test-lock.js';

type ManagedKey = 'TELEGRAM_TEST_SESSIONS' | 'TELEGRAM_TEST_BOT_TOKENS';
interface Assignment { key: string; start: number; end: number }
const managedKeys: ManagedKey[] = ['TELEGRAM_TEST_SESSIONS', 'TELEGRAM_TEST_BOT_TOKENS'];
const whitespace = (character: string | undefined) => character !== undefined && ' \t\n\r'.includes(character);

function assignments(source: string): Assignment[] {
  const result: Assignment[] = [];
  let limit = source.length;
  while (whitespace(source[limit - 1])) limit--;
  const trimStart = (offset: number) => {
    while (offset < limit && whitespace(source[offset])) offset++;
    return offset;
  };
  const trim = (value: string) => value.replaceAll('\r', '').replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  let cursor = trimStart(0);
  // Match Node's parser, not shell escaping: quotes close at the next matching
  // quote, including on later lines. Otherwise an unrelated multiline value can
  // be mistaken for managed assignments. CRs are ignored by Node, but retained
  // in our source slices. See Dotenv::ParseContent:
  // https://github.com/nodejs/node/blob/v26.13.0/src/node_dotenv.cc
  while (cursor < limit) {
    while (source[cursor] === '\r') cursor++;
    if (cursor >= limit) break;
    if (source[cursor] === '#' || source[cursor] === '\n') {
      const newline = source.indexOf('\n', cursor);
      cursor = newline === -1 ? limit : newline + 1;
      continue;
    }
    let start = cursor;
    while (source[start] === ' ' || source[start] === '\t' || source[start] === '\r') start++;
    let equal = cursor;
    while (equal < limit && source[equal] !== '=' && source[equal] !== '\n') equal++;
    if (equal === limit) break;
    if (source[equal] === '\n') { cursor = trimStart(equal + 1); continue; }
    let key = trim(source.slice(cursor, equal));
    cursor = equal + 1;
    while (source[cursor] === '\r') cursor++;
    if (cursor >= limit || source[cursor] === '\n') {
      result.push({ key, start, end: equal + 1 });
      continue;
    }
    cursor = trimStart(cursor);
    if (!key) continue;
    if (key.startsWith('export ')) key = trim(key.slice(7));
    let end: number;
    const quote = source[cursor];
    if (quote === '"' || quote === "'" || quote === '`') {
      const closing = source.indexOf(quote, cursor + 1);
      if (closing !== -1 && closing < limit) {
        end = closing + 1;
        const newline = source.indexOf('\n', end);
        cursor = newline === -1 ? limit : newline + 1;
        result.push({ key, start, end });
        continue;
      }
      const newline = source.indexOf('\n', cursor);
      end = newline === -1 ? limit : newline;
      cursor = trimStart(end + 1);
    } else {
      const newline = source.indexOf('\n', cursor);
      end = newline === -1 ? limit : newline;
      const hash = source.indexOf('#', cursor);
      if (hash !== -1 && hash < end) end = hash;
      cursor = trimStart(newline === -1 ? limit : newline + 1);
    }
    while (end > equal + 1 && whitespace(source[end - 1])) end--;
    result.push({ key, start, end });
  }
  return result;
}

function replaceAssignment(source: string, key: ManagedKey, value?: string): string {
  const matches = assignments(source).filter(assignment => assignment.key === key);
  const last = matches.at(-1);
  if (!last) return value === undefined ? source : `${source}${source.endsWith('\n') || !source ? '' : '\n'}${key}='${value}'\n`;
  const replacement = value === undefined ? source.slice(last.start, last.end) : `${key}='${value}'`;
  const chunks: string[] = [];
  let offset = 0;
  for (const match of matches) {
    chunks.push(source.slice(offset, match.start), match === last ? replacement : '');
    offset = match.end;
  }
  chunks.push(source.slice(offset));
  return chunks.join('');
}

async function accessFile<T>(filename: string, callback: (file: FileHandle, metadata: Stats) => Promise<T>): Promise<T> {
  const file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let failed = false;
  let failure: unknown;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Refusing to save Telegram test credentials in a non-regular or hard-linked file');
    return await callback(file, metadata);
  } catch (error) { failed = true; failure = error; throw error; } finally {
    try { await file.close(); } catch (cleanup) {
      if (failed) throw combineTelegramErrors(failure, cleanup);
      throw cleanup;
    }
  }
}

async function replaceFile(filename: string, contents: string, metadata: Stats, signal?: AbortSignal): Promise<void> {
  const temporary = join(dirname(filename), `.telegram-env-${randomUUID()}.tmp`);
  const handles: FileHandle[] = [];
  const failures: unknown[] = [];
  let created = false;
  let renamed = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    handles.push(file);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    const directory = await open(dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY);
    handles.push(directory);
    const current = await lstat(filename);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== metadata.dev || current.ino !== metadata.ino) {
      throw new Error('Telegram test credential storage changed before replacement');
    }
    signal?.throwIfAborted();
    await rename(temporary, filename);
    renamed = true;
    await directory.sync();
  } catch (error) { failures.push(error); } finally {
    for (const file of handles.reverse()) {
      try { await file.close(); } catch (cleanup) { failures.push(cleanup); }
    }
    if (created && !renamed) {
      try { await unlink(temporary); } catch (cleanup) { failures.push(cleanup); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw combineTelegramErrors(...failures);
}

// Writers hold the existing authorization lock across the entire callback. A
// fresh descriptor per save is essential: atomic rename detaches the old inode.
export async function withTelegramTestEnvStorage<T>(filename: string, callback: (storage: {
  env: NodeJS.ProcessEnv;
  save(key: ManagedKey, value: string): Promise<void>;
  compact(): Promise<void>;
}) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let contents = await accessFile(filename, file => file.readFile('utf8'));
  const env = parseEnv(contents);
  const persist = async (next: string, expected: NodeJS.ProcessEnv) => {
    if (!isDeepStrictEqual({ ...parseEnv(next) }, { ...expected })) throw new Error('Telegram test credential replacement would change unrelated dotenv values');
    await accessFile(filename, async (file, metadata) => {
      if (await file.readFile('utf8') !== contents) throw new Error('Telegram test credential storage changed during authorization');
      signal?.throwIfAborted();
      await file.chmod(0o600);
      if (next !== contents) await replaceFile(filename, next, metadata, signal);
    });
    contents = next;
    Object.assign(env, expected);
  };
  return callback({ env, async save(key, value) {
    // Keep the existing representation for a semantic no-op, while still
    // collapsing old assignments and hardening permissions.
    const unchanged = env[key] !== undefined && isDeepStrictEqual(JSON.parse(env[key]!), JSON.parse(value));
    if (!unchanged && value.includes("'")) throw new Error('Telegram test credential JSON must encode single quotes');
    const next = replaceAssignment(contents, key, unchanged ? undefined : value);
    await persist(next, unchanged ? env : { ...env, [key]: value });
  }, async compact() {
    let next = contents;
    for (const key of managedKeys) next = replaceAssignment(next, key);
    await persist(next, env);
  } });
}

// Operational compaction retains each last assignment verbatim, never merging
// historical session lists or changing any value returned by Node's parser.
export async function compactTelegramTestEnv(filename: string, signal: AbortSignal): Promise<void> {
  await withTelegramTestLock('authorization', signal, () => withTelegramTestEnvStorage(filename, storage => storage.compact(), signal));
}
