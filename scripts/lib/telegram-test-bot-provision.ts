import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Conversation } from '@mtcute/node';
import { forkTelegramTestSession } from './telegram-test-sessions.js';
import { withTelegramTestLock } from './telegram-test-lock.js';
import { appendTelegramTestBotToken } from './telegram-test-bot-storage.js';
import { combineTelegramErrors } from '../../test/e2e/helpers/errors.js';
import { createTelegramTestApi } from '../../test/e2e/helpers/telegram-resources.js';

export async function saveTelegramTestBot(filename: string, token: string, signal: AbortSignal): Promise<string> {
  if (!/^[1-9]\d*:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Invalid Telegram bot token');
  signal.throwIfAborted();
  const me = await createTelegramTestApi(token, signal).getMe();
  const id = token.split(':')[0]!;
  if (!me.is_bot || String(me.id) !== id) throw new Error('Telegram test Bot API returned a different bot identity');
  await appendTelegramTestBotToken(filename, token, signal);
  return id;
}

async function durableJournal(path: string, value: object, create: boolean): Promise<void> {
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('Unsafe bot recovery journal');
    const body = JSON.stringify(value) + '\n';
    await file.writeFile(body);
    await file.truncate(Buffer.byteLength(body));
    await file.sync();
  } finally { await file.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function createTelegramTestBot(filename: string, signal: AbortSignal): Promise<string> {
  const session = await forkTelegramTestSession(signal);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= session.close();
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let failure: unknown;
  let failed = false;
  try {
    signal.throwIfAborted();
    return await withTelegramTestLock('botfather', signal, async () => {
      const conversation = new Conversation(session.client, 'BotFather');
      return conversation.with(async () => {
        const prompt = async (text: string): Promise<string> => {
          for (;;) {
            signal.throwIfAborted();
            const sent = await conversation.sendText(text);
            const reply = await conversation.waitForResponse(undefined, { message: sent.id, timeout: 30000 });
            signal.throwIfAborted();
            const cooldown = /^Sorry, too many attempts\. Please try again in (\d+) seconds\.$/.exec(reply.text.trim());
            if (!cooldown) return reply.text;
            const seconds = Number(cooldown[1]);
            if (!Number.isSafeInteger(seconds) || seconds > 2147483) throw new Error(`Unsupported BotFather cooldown:\n${reply.text}`);
            console.error(`BotFather rejected the request:\n${reply.text}`);
            await setTimeout(seconds * 1000, undefined, { signal });
          }
        };
        await prompt('/cancel');
        const requested = await prompt('/newbot');
        if (!/how are we going to call it|choose a name/i.test(requested)) throw new Error(`Unexpected BotFather response:\n${requested}`);
        const suffix = randomBytes(8).toString('hex');
        const named = await prompt(`OMP Test ${suffix}`);
        if (!/choose a username/i.test(named)) throw new Error(`Unexpected BotFather response:\n${named}`);
        const username = `omp_test_${suffix}_bot`;
        const recovery = join(homedir(), '.local/state/omp-telegram-test/provisioned-bots');
        await mkdir(recovery, { recursive: true, mode: 0o700 });
        const metadata = await lstat(recovery);
        if (!metadata.isDirectory() || metadata.uid !== process.getuid?.()) throw new Error('Unsafe bot recovery directory');
        await chmod(recovery, 0o700);
        const journal = join(recovery, `${suffix}.json`);
        await durableJournal(journal, { username }, true);
        const reply = await prompt(username);
        const token = reply.match(/(?:^|\s)([1-9]\d*:[A-Za-z0-9_-]{30,})(?=\s|$)/)?.[1];
        if (!token) throw new Error(`Unexpected BotFather response (recovery journal: ${journal}):\n${reply}`);
        await durableJournal(journal, { username, token }, false);
        const id = await saveTelegramTestBot(filename, token, signal);
        await unlink(journal);
        const directory = await open(dirname(journal), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return id;
      });
    });
  } catch (error) { failure = error; failed = true; throw error; }
  finally {
    signal.removeEventListener('abort', abort);
    try { await close(); } catch (cleanup) {
      if (failed) throw combineTelegramErrors(failure, cleanup);
      throw cleanup;
    }
  }
}
