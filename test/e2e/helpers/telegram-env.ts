import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { readTelegramTestSessions, validateTelegramTestSession } from '../../../scripts/lib/telegram-test-auth.js';
import { combineTelegramErrors } from './errors.js';

let pendingAppend: Promise<void> = Promise.resolve();

export async function appendTelegramTestSession(filename: string, session: string): Promise<void> {
  validateTelegramTestSession(session);
  const pending = pendingAppend.then(() => appendSession(filename, session));
  pendingAppend = pending.catch(() => {});
  await pending;
}

async function appendSession(filename: string, session: string): Promise<void> {
  const file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Refusing to save Telegram test sessions in a non-regular or hard-linked file');
    const env = parseEnv(await file.readFile('utf8'));
    const sessions = env.TELEGRAM_TEST_SESSIONS === undefined ? [] : readTelegramTestSessions(env);
    await file.chmod(0o600);
    if (!sessions.includes(session)) {
      sessions.push(session);
      await file.appendFile(`\nTELEGRAM_TEST_SESSIONS='${JSON.stringify(sessions).replaceAll("'", '\\u0027')}'\n`, 'utf8');
      await file.sync();
    }
  } catch (error) {
    try { await file.close(); } catch (cleanupError) { throw combineTelegramErrors(error, cleanupError); }
    throw error;
  }
  await file.close();
}
