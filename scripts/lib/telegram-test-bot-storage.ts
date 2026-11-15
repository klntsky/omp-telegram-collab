import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { combineTelegramErrors } from '../../test/e2e/helpers/errors.js';
import { readTelegramTestBotTokens } from './telegram-test-bots.js';
import { withTelegramTestLock } from './telegram-test-lock.js';

export async function appendTelegramTestBotToken(filename: string, token: string, signal: AbortSignal): Promise<void> {
  readTelegramTestBotTokens({ TELEGRAM_TEST_BOT_TOKENS: JSON.stringify([token]) });
  await withTelegramTestLock(`bot:${token.split(':')[0]}`, signal, () => withTelegramTestLock('authorization', signal, async () => {
    signal.throwIfAborted();
    const file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    let failure: unknown;
    let failed = false;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Refusing to save Telegram test bot tokens in a non-regular or hard-linked file');
      const env = parseEnv(await file.readFile('utf8'));
      const tokens = env.TELEGRAM_TEST_BOT_TOKENS === undefined ? [] : readTelegramTestBotTokens(env);
      const existing = tokens.findIndex(value => value.split(':')[0] === token.split(':')[0]);
      await file.chmod(0o600);
      if (existing !== -1 && tokens[existing] === token) return;
      if (existing === -1) tokens.push(token); else tokens[existing] = token;
      signal.throwIfAborted();
      await file.appendFile(`\nTELEGRAM_TEST_BOT_TOKENS='${JSON.stringify(tokens)}'\n`, 'utf8');
      await file.sync();
    } catch (error) { failure = error; failed = true; throw error; } finally {
      try { await file.close(); } catch (cleanup) {
        if (failed) throw combineTelegramErrors(failure, cleanup);
        throw cleanup;
      }
    }
  }));
}
