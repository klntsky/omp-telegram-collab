import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { TelegramClient } from '@mtcute/node';
import { defaultProductionDc, defaultTestDc, writeStringSession } from '@mtcute/node/utils.js';
import { appendTelegramTestSession } from './e2e/helpers/telegram-env.js';
import { readTelegramTestCredentials, TelegramTestUser } from './e2e/helpers/telegram-user.js';

function session(testMode = true): string {
  return writeStringSession({ version: 3, primaryDcs: testMode ? defaultTestDc : defaultProductionDc, authKey: randomBytes(256) });
}

test('saved Telegram sessions append without losing existing config and become private', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-test-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, '.env');
  const original = '# Keep existing settings\nTELEGRAM_TEST_API_ID=123\nTELEGRAM_TEST_API_HASH=fixture\nUNRELATED=keep';
  await writeFile(filename, original, { mode: 0o644 });
  const first = session();
  await appendTelegramTestSession(filename, first);
  const firstConfig = await readFile(filename, 'utf8');
  assert.equal(firstConfig.slice(0, original.length), original);
  assert.deepEqual({ ...parseEnv(firstConfig) }, {
    TELEGRAM_TEST_API_ID: '123', TELEGRAM_TEST_API_HASH: 'fixture', UNRELATED: 'keep', TELEGRAM_TEST_SESSION: first,
  });
  assert.equal((await stat(filename)).mode & 0o777, 0o600);

  const refreshed = session();
  await appendTelegramTestSession(filename, refreshed);
  const configuration = readTelegramTestCredentials(parseEnv(await readFile(filename, 'utf8')));
  assert.equal(configuration.session, refreshed);
  assert.equal(configuration.apiId, 123);
  assert.equal(configuration.apiHash, 'fixture');
});

test('production Telegram sessions cannot authorize tests or modify their environment file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-test-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, '.env');
  const original = 'UNRELATED=keep\n';
  await writeFile(filename, original);
  const production = session(false);
  const calls = t.mock.method(TelegramClient.prototype, 'call', async () => { throw new Error('Unexpected network request'); });
  await assert.rejects(TelegramTestUser.login({ apiId: 123, apiHash: 'fixture', session: production }));
  assert.equal(calls.mock.callCount(), 0);
  await assert.rejects(appendTelegramTestSession(filename, production));
  assert.equal(await readFile(filename, 'utf8'), original);
});
