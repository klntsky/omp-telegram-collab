import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readStringSession, writeStringSession } from '@mtcute/node/utils.js';
import { readTelegramTestCredentials, readTelegramTestSessions } from '../scripts/lib/telegram-test-auth.js';
import { appendTelegramTestSession } from './e2e/helpers/telegram-env.js';

function session(seed: number, testMode = true, isBot = false): string {
  return writeStringSession(readStringSession({
    testMode,
    authKey: new Uint8Array(256).fill(seed),
    self: { userId: seed, isBot, isPremium: false, usernames: [] },
  }));
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-telegram-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: join(directory, '.env') };
}

test('canonical sessions validate the entire unique list and credentials select its first entry', () => {
  const first = session(1); const second = session(2);
  const env = { TELEGRAM_TEST_API_ID: '1', TELEGRAM_TEST_API_HASH: 'hash', TELEGRAM_TEST_SESSIONS: JSON.stringify([first, second]) };
  assert.deepEqual(readTelegramTestSessions(env), [first, second]);
  assert.equal(readTelegramTestCredentials(env).session, first);
  for (const value of ['', 'no-json', '{}', '[]', '[null]', '[" "]', JSON.stringify([first, first]), JSON.stringify([first, session(3, false)]), JSON.stringify([first, session(3, true, true)])]) {
    assert.throws(() => readTelegramTestSessions({ TELEGRAM_TEST_SESSIONS: value }));
  }
  assert.throws(() => readTelegramTestSessions({ TELEGRAM_TEST_SESSION: first }));
});

test('concurrent appends retain existing sessions, unrelated dotenv bytes and deduplicate', async t => {
  const { filename } = await fixture(t);
  const first = session(1); const second = session(2); const third = session(3);
  const original = `# keep this comment\nUNRELATED="unchanged value"\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([first])}'\n`;
  await writeFile(filename, original, { mode: 0o644 });
  await Promise.all([appendTelegramTestSession(filename, second), appendTelegramTestSession(filename, third), appendTelegramTestSession(filename, second)]);
  const contents = await readFile(filename, 'utf8');
  assert(contents.startsWith(original));
  assert.equal(parseEnv(contents).UNRELATED, 'unchanged value');
  assert.deepEqual(readTelegramTestSessions(parseEnv(contents)), [first, second, third]);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await appendTelegramTestSession(filename, first);
  assert.equal(await readFile(filename, 'utf8'), contents);
});

test('invalid existing canonical state is unchanged and does not poison later appends', async t => {
  const { filename } = await fixture(t);
  const original = "UNRELATED=value\nTELEGRAM_TEST_SESSIONS='[]'\n";
  await writeFile(filename, original);
  await assert.rejects(appendTelegramTestSession(filename, session(1)));
  assert.equal(await readFile(filename, 'utf8'), original);
  await writeFile(filename, 'UNRELATED=value\n');
  await appendTelegramTestSession(filename, session(2));
  assert.deepEqual(readTelegramTestSessions(parseEnv(await readFile(filename, 'utf8'))), [session(2)]);
});

test('symlink and hard-link targets are never modified', async t => {
  const { directory, filename } = await fixture(t);
  const target = join(directory, 'target');
  const contents = 'UNRELATED=preserve\n';
  await writeFile(target, contents, { mode: 0o644 });
  await symlink(target, filename);
  await assert.rejects(appendTelegramTestSession(filename, session(1)));
  assert.equal(await readFile(target, 'utf8'), contents);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  const hardlink = join(directory, 'hardlink');
  await link(target, hardlink);
  await assert.rejects(appendTelegramTestSession(hardlink, session(1)));
  assert.equal(await readFile(target, 'utf8'), contents);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});
