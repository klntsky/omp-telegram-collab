import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readStringSession, writeStringSession } from '@mtcute/node/utils.js';
import { appendTelegramTestBotToken } from '../scripts/lib/telegram-test-bot-storage.js';
import { readTelegramTestBotTokens } from '../scripts/lib/telegram-test-bots.js';
import { acquireTelegramTestLock } from '../scripts/lib/telegram-test-lock.js';
import { appendTelegramTestSession } from './e2e/helpers/telegram-env.js';

const storageUrl = new URL('../scripts/lib/telegram-test-bot-storage.ts', import.meta.url).href;
const signal = () => new AbortController().signal;
const token = (id = randomInt(100000000, 1900000000), secret = 'a') => `${id}:${secret.repeat(35)}`;
const session = (seed: number) => writeStringSession(readStringSession({
  testMode: true,
  authKey: new Uint8Array(256).fill(seed),
  self: { userId: seed, isBot: false, isPremium: false, usernames: [] },
}));

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-bot-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: join(directory, '.env') };
}

function worker() {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { appendTelegramTestBotToken } from ${JSON.stringify(storageUrl)};
    process.once('message', async ({ filename, token }) => {
      const pending = appendTelegramTestBotToken(filename, token, new AbortController().signal);
      process.send('waiting');
      await pending;
      process.send('saved');
      process.disconnect();
    });
    process.send('ready');
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}

async function pool(filename: string) {
  return readTelegramTestBotTokens(parseEnv(await readFile(filename, 'utf8')));
}

test('append and dedup preserve dotenv bytes, all sessions and unrelated settings', async t => {
  const { filename } = await fixture(t);
  const first = token(); const second = token();
  const original = `# untouched\nUNRELATED="value with spaces"\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([session(1), session(2)])}'\n`;
  await writeFile(filename, original, { mode: 0o644 });
  await Promise.all([first, second, first].map(value => appendTelegramTestBotToken(filename, value, signal())));
  const contents = await readFile(filename, 'utf8');
  assert(contents.startsWith(original));
  assert.deepEqual(new Set(await pool(filename)), new Set([first, second]));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await appendTelegramTestBotToken(filename, first, signal());
  assert.equal(await readFile(filename, 'utf8'), contents);
});

test('creates private storage and replaces credentials in place without dropping other bots', async t => {
  const { filename } = await fixture(t);
  const first = token(); const other = token();
  await appendTelegramTestBotToken(filename, first, signal());
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await appendTelegramTestBotToken(filename, other, signal());
  const replacement = first.replace(/a/g, 'b');
  await appendTelegramTestBotToken(filename, replacement, signal());
  assert.deepEqual(await pool(filename), [replacement, other]);
});

test('duplicate token import secures existing storage without changing retained credentials', async t => {
  const { filename } = await fixture(t);
  const existing = token();
  const contents = `TELEGRAM_TEST_BOT_TOKENS='${JSON.stringify([existing])}'\n`;
  await writeFile(filename, contents, { mode: 0o644 });
  await appendTelegramTestBotToken(filename, existing, signal());
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(await readFile(filename, 'utf8'), contents);
});

test('invalid input and invalid canonical pools are unchanged without exposing credentials', async t => {
  const { filename } = await fixture(t);
  const good = token();
  for (const state of ['[]', '[null]', 'invalid', JSON.stringify([good, good])]) {
    const original = `TELEGRAM_TEST_BOT_TOKENS='${state}'\n`;
    await writeFile(filename, original);
    await assert.rejects(appendTelegramTestBotToken(filename, good, signal()), error => error instanceof Error && !error.message.includes(good));
    assert.equal(await readFile(filename, 'utf8'), original);
  }
  await writeFile(filename, 'UNRELATED=preserve\n');
  const invalid = 'sensitive-invalid-token';
  await assert.rejects(appendTelegramTestBotToken(filename, invalid, signal()), error => error instanceof Error && !error.message.includes(invalid));
  assert.equal(await readFile(filename, 'utf8'), 'UNRELATED=preserve\n');
  await appendTelegramTestBotToken(filename, good, signal());
  assert.deepEqual(await pool(filename), [good]);
});

test('symlinks, hard links and nonregular files are rejected without modifying targets', async t => {
  const { directory, filename } = await fixture(t);
  const target = join(directory, 'target');
  const original = 'UNRELATED=preserve\n';
  await writeFile(target, original, { mode: 0o644 });
  await symlink(target, filename);
  await assert.rejects(appendTelegramTestBotToken(filename, token(), signal()));
  const hardlink = join(directory, 'hardlink');
  await link(target, hardlink);
  await assert.rejects(appendTelegramTestBotToken(hardlink, token(), signal()));
  const folder = join(directory, 'folder');
  await mkdir(folder);
  await assert.rejects(appendTelegramTestBotToken(folder, token(), signal()));
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test('cross-process append serializes with session writers on the authorization lock', { timeout: 15000 }, async t => {
  const { filename } = await fixture(t);
  const first = token(); const second = token();
  const original = `UNRELATED=preserve\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([session(3)])}'\n`;
  await writeFile(filename, original);
  const release = await acquireTelegramTestLock('authorization', signal());
  const child = worker();
  const exited = once(child, 'exit');
  const sessionWrite = appendTelegramTestSession(filename, session(4));
  try {
    await once(child, 'message');
    const waiting = once(child, 'message');
    child.send({ filename, token: first });
    assert.equal((await waiting)[0], 'waiting');
    assert.equal(await readFile(filename, 'utf8'), original);
    const saved = once(child, 'message');
    const otherWrite = appendTelegramTestBotToken(filename, second, signal());
    await release!();
    await Promise.all([sessionWrite, otherWrite]);
    assert.equal((await saved)[0], 'saved');
    assert.equal((await exited)[0], 0);
    const contents = await readFile(filename, 'utf8');
    assert(contents.startsWith(original));
    assert.deepEqual(JSON.parse(parseEnv(contents).TELEGRAM_TEST_SESSIONS!), [session(3), session(4)]);
    assert.deepEqual(new Set(await pool(filename)), new Set([first, second]));
  } finally {
    child.kill('SIGKILL');
    await release!();
    await sessionWrite;
  }
});

test('cross-process replacement waits for an active bot lease and cancellation leaves state untouched', { timeout: 15000 }, async t => {
  const { filename } = await fixture(t);
  const first = token(); const other = token();
  await appendTelegramTestBotToken(filename, first, signal());
  await appendTelegramTestBotToken(filename, other, signal());
  const original = await readFile(filename, 'utf8');
  const release = await acquireTelegramTestLock(`bot:${first.split(':')[0]}`, signal());
  const child = worker();
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    const waiting = once(child, 'message');
    const replacement = first.replace(/a/g, 'b');
    child.send({ filename, token: replacement });
    assert.equal((await waiting)[0], 'waiting');
    const controller = new AbortController();
    const reason = new Error('cancel token replacement');
    const pending = appendTelegramTestBotToken(filename, replacement, controller.signal);
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(await readFile(filename, 'utf8'), original);
    const saved = once(child, 'message');
    await release!();
    assert.equal((await saved)[0], 'saved');
    assert.equal((await exited)[0], 0);
    assert.deepEqual(await pool(filename), [replacement, other]);
  } finally {
    child.kill('SIGKILL');
    await release!();
  }
});
