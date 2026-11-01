import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createTelegramTestClient, readTelegramApplicationCredentials, validateTelegramTestSession } from '../test/e2e/helpers/telegram-user.js';
import { appendTelegramTestSession } from '../test/e2e/helpers/telegram-env.js';
import { combineTelegramErrors } from '../test/e2e/helpers/errors.js';

const credentials = readTelegramApplicationCredentials();
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run pnpm telegram:test:login in an interactive terminal');
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
const interrupt = () => controller.abort(new Error('Telegram test login interrupted'));
let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
const input = createInterface({ input: process.stdin, output, terminal: true });
const ask = async (prompt: string, hidden = false): Promise<string> => {
  process.stdout.write(prompt);
  muted = hidden;
  try { return await input.question('', { signal }); }
  finally { muted = false; if (hidden) process.stdout.write('\n'); }
};
input.on('SIGINT', interrupt);
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const client = createTelegramTestClient(credentials);
const errors: unknown[] = [];
let closing: Promise<void> | undefined;
const close = () => closing ??= client.destroy();
const closeOnAbort = () => { void close().catch(error => { if (!errors.includes(error)) errors.push(error); }); };
signal.addEventListener('abort', closeOnAbort, { once: true });
try {
  const config = await client.call({ _: 'help.getConfig' }, { timeout: 30000, abortSignal: signal });
  if (!config.testMode) throw new Error('Refusing to authorize an account outside the Telegram test network');
  console.log("Use the phone number registered in Telegram's test environment and the actual code delivered to that account.");
  const user = await client.start({
    phone: () => ask('Test account phone number: '),
    code: () => ask('Verification code (hidden): ', true),
    password: () => ask('Two-step verification password (hidden): ', true),
    abortSignal: signal,
  });
  if (user.isBot) throw new Error('Telegram test provisioning requires a user account');
  const session = await client.exportSession();
  validateTelegramTestSession(session);
  signal.throwIfAborted();
  const filename = resolve('.env');
  await appendTelegramTestSession(filename, session);
  console.log(`Appended TELEGRAM_TEST_SESSION to ${filename} with permissions 0600. The session was not printed.`);
} catch (error) {
  if (signal.aborted && error !== signal.reason) errors.push(signal.reason);
  errors.push(error);
} finally {
  input.close();
  output.end();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  signal.removeEventListener('abort', closeOnAbort);
  try { await close(); } catch (error) { if (!errors.includes(error)) errors.push(error); }
}
if (errors.length === 1) throw errors[0];
if (errors.length > 1) throw combineTelegramErrors(...errors);
