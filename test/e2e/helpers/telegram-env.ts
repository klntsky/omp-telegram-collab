import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readTelegramTestSessions, validateTelegramTestSession } from '../../../scripts/lib/telegram-test-auth.js';
import { readStringSession } from '@mtcute/node/utils.js';
import { withTelegramTestLock } from '../../../scripts/lib/telegram-test-lock.js';
import { withTelegramTestEnvStorage } from '../../../scripts/lib/telegram-test-env-storage.js';

// Keep the retained authorization pool file-backed. Loading it into the test
// runner with --env-file can exceed Linux's per-string environment limit before
// Node can spawn its first test worker.
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
  return withTelegramTestEnvStorage(filename, async storage => {
    const sessions = storage.env.TELEGRAM_TEST_SESSIONS === undefined || (allowEmpty && storage.env.TELEGRAM_TEST_SESSIONS === '[]') ? [] : readTelegramTestSessions(storage.env);
    return callback({ env: storage.env, sessions, async save(next) {
      for (const session of next) validateTelegramTestSession(session);
      if (new Set(next).size !== next.length) throw new Error('Duplicate Telegram test sessions');
      await storage.save('TELEGRAM_TEST_SESSIONS', JSON.stringify(next).replaceAll("'", '\\u0027'));
    } });
  });
}

export async function appendTelegramTestSession(filename: string, session: string): Promise<void> {
  validateTelegramTestSession(session);
  await withTelegramTestLock('authorization', new AbortController().signal, () => withTelegramTestSessionStorage(filename, async storage => {
    const key = Buffer.from(readStringSession(session).authKey);
    const existing = storage.sessions.findIndex(value => key.equals(readStringSession(value).authKey));
    const next = [...storage.sessions];
    if (existing === -1) next.push(session); else next[existing] = session;
    await storage.save(next);
  }, true));
}
