import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { readTelegramTestSessions, validateTelegramTestSession } from '../../../scripts/lib/telegram-test-auth.js';
import { readStringSession } from '@mtcute/node/utils.js';
import { withTelegramTestLock } from '../../../scripts/lib/telegram-test-lock.js';

export async function resolveTelegramTestEnvFile(): Promise<string> {
  if (process.env.TELEGRAM_TEST_ENV_FILE) return resolve(process.env.TELEGRAM_TEST_ENV_FILE);
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return resolve(dirname(stdout.trim()), '.env');
}

export async function withTelegramTestSessionStorage<T>(filename: string, callback: (storage: {
  env: NodeJS.ProcessEnv;
  sessions: string[];
  save(sessions: string[]): Promise<void>;
}) => Promise<T>, allowEmpty = false): Promise<T> {
  const file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let failure: unknown;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Refusing to save Telegram test sessions in a non-regular or hard-linked file');
    const env = parseEnv(await file.readFile('utf8'));
    const sessions = env.TELEGRAM_TEST_SESSIONS === undefined || (allowEmpty && env.TELEGRAM_TEST_SESSIONS === '[]') ? [] : readTelegramTestSessions(env);
    return await callback({ env, sessions, async save(next) {
      for (const session of next) validateTelegramTestSession(session);
      if (new Set(next).size !== next.length) throw new Error('Duplicate Telegram test sessions');
      await file.chmod(0o600);
      await file.appendFile(`\nTELEGRAM_TEST_SESSIONS='${JSON.stringify(next).replaceAll("'", '\\u0027')}'\n`, 'utf8');
      await file.sync();
    } });
  } catch (error) { failure = error; throw error; } finally {
    try { await file.close(); } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'Telegram session storage and cleanup failed');
      throw error;
    }
  }
}

export async function appendTelegramTestSession(filename: string, session: string): Promise<void> {
  validateTelegramTestSession(session);
  await withTelegramTestLock('authorization', new AbortController().signal, () => withTelegramTestSessionStorage(filename, async storage => {
    const key = Buffer.from(readStringSession(session).authKey);
    const existing = storage.sessions.findIndex(value => key.equals(readStringSession(value).authKey));
    if (existing === -1) await storage.save([...storage.sessions, session]);
    else if (storage.sessions[existing] !== session) {
      const next = [...storage.sessions];
      next[existing] = session;
      await storage.save(next);
    }
  }, true));
}
