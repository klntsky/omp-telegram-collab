import { createHash, randomBytes } from 'node:crypto';
import { mkdir, chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Conversation, type TelegramClient } from '@mtcute/node';
import { withTelegramTestLock } from './telegram-test-lock.js';

const recoveryDirectory = join(homedir(), '.local/state/omp-telegram-test/disposable-bots');
const tokenPath = (token: string) => join(recoveryDirectory, `${createHash('sha256').update(token).digest('hex')}.json`);
const redactTokens = (text: string) => text.replace(/[1-9]\d*:[A-Za-z0-9_-]{30,}/g, '[redacted bot token]');

async function conversationWith<T>(client: TelegramClient, signal: AbortSignal, callback: (exchange: (text: string) => Promise<string>) => Promise<T>): Promise<T> {
  return withTelegramTestLock('botfather', signal, async () => {
    signal.throwIfAborted();
    const conversation = new Conversation(client, 'BotFather');
    const stop = () => conversation.stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await conversation.with(async () => callback(async text => {
        for (;;) {
          signal.throwIfAborted();
          const sent = await conversation.sendText(text, { abortSignal: signal });
          signal.throwIfAborted();
          const response = await conversation.waitForResponse(undefined, { message: sent.id, timeout: 30000 });
          signal.throwIfAborted();
          const rejected = /^Sorry, too many attempts\. Please try again in (\d+) seconds\.$/.exec(response.text);
          if (!rejected) return response.text;
          const milliseconds = Number(rejected[1]) * 1000;
          if (!Number.isSafeInteger(milliseconds) || milliseconds > 2147483647) {
            throw new Error(`BotFather retry delay exceeds the supported timer range:\n${response.text}`);
          }
          console.error(`BotFather rejected the request:\n${response.text}`);
          await delay(milliseconds, undefined, { signal });
        }
      }));
    } finally { signal.removeEventListener('abort', stop); }
  });
}

function expectResponse(text: string, expected: RegExp): void {
  if (!expected.test(text)) throw new Error(`Unexpected BotFather response:\n${redactTokens(text)}`);
}

export async function createTelegramTestBot(client: TelegramClient, shutdownSignal: AbortSignal): Promise<string> {
  const signal = AbortSignal.any([client.stopSignal, shutdownSignal]);
  return conversationWith(client, signal, async exchange => {
    await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
    await chmod(recoveryDirectory, 0o700);
    await exchange('/cancel');
    expectResponse(await exchange('/newbot'), /how are we going to call it|choose a name for your bot/i);
    expectResponse(await exchange(`omp_e2e_${randomBytes(8).toString('hex')}`), /choose a username for your bot/i);
    const username = `omp_e2e_${randomBytes(8).toString('hex')}_bot`;
    const pendingPath = join(recoveryDirectory, `${username}.json`);
    await writeFile(pendingPath, JSON.stringify({ username, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    const created = await exchange(username);
    const token = created.match(/(?<![A-Za-z0-9_:-])[1-9]\d*:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/)?.[0];
    if (!token) throw new Error(`Unexpected BotFather response:\n${redactTokens(created)}`);
    await writeFile(pendingPath, JSON.stringify({ username, token, createdAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(pendingPath, tokenPath(token));
    return token;
  });
}

export async function deleteTelegramTestBot(client: TelegramClient, token: string, shutdownSignal: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([client.stopSignal, shutdownSignal]);
  await conversationWith(client, signal, async exchange => {
    const path = tokenPath(token);
    const record = JSON.parse(await readFile(path, 'utf8')) as { username: string; token: string };
    if (record.token !== token || !/^omp_e2e_[a-f0-9]{16}_bot$/.test(record.username)) throw new Error('Invalid disposable Telegram bot recovery record');
    await exchange('/cancel');
    expectResponse(await exchange('/deletebot'), /choose (?:a|the) bot|which bot/i);
    expectResponse(await exchange(`@${record.username}`), /Yes, I am totally sure\./);
    const deleted = await exchange('Yes, I am totally sure.');
    expectResponse(deleted, /(?:bot (?:was |has been )?(?:successfully )?deleted|deleted (?:the |your )?bot|the bot is gone|gone\. hope you enjoyed)/i);
    await unlink(path);
  });
}
