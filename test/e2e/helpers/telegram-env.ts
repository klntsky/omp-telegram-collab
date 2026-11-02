import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { validateTelegramTestSession } from './telegram-user.js';
import { combineTelegramErrors } from './errors.js';

export async function appendTelegramTestSession(filename: string, session: string): Promise<void> {
  validateTelegramTestSession(session);
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.appendFile(`\nTELEGRAM_TEST_SESSION=${JSON.stringify(session)}\n`, 'utf8');
  } catch (error) {
    try { await file.close(); } catch (cleanupError) { throw combineTelegramErrors(error, cleanupError); }
    throw error;
  }
  await file.close();
}
