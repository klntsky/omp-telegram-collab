import { withTelegramTestEnvStorage } from './telegram-test-env-storage.js';
import { readTelegramTestBotTokens } from './telegram-test-bots.js';
import { withTelegramTestLock } from './telegram-test-lock.js';

export async function appendTelegramTestBotToken(filename: string, token: string, signal: AbortSignal): Promise<void> {
  readTelegramTestBotTokens({ TELEGRAM_TEST_BOT_TOKENS: JSON.stringify([token]) });
  await withTelegramTestLock(`bot:${token.split(':')[0]}`, signal, () => withTelegramTestLock('authorization', signal, async () => {
    signal.throwIfAborted();
    await withTelegramTestEnvStorage(filename, async storage => {
      const tokens = storage.env.TELEGRAM_TEST_BOT_TOKENS === undefined ? [] : readTelegramTestBotTokens(storage.env);
      const existing = tokens.findIndex(value => value.split(':')[0] === token.split(':')[0]);
      if (existing === -1) tokens.push(token); else tokens[existing] = token;
      await storage.save('TELEGRAM_TEST_BOT_TOKENS', JSON.stringify(tokens));
    }, signal);
  }));
}
