import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { tl } from '@mtcute/node';
import { readStringSession, writeStringSession } from '@mtcute/node/utils.js';
import { isDeadTelegramTestSession, telegramTestSessionLockName } from '../scripts/lib/telegram-test-sessions.js';
import { appendTelegramTestSession, withTelegramTestSessionStorage } from './e2e/helpers/telegram-env.js';
import { withTelegramTestLock } from '../scripts/lib/telegram-test-lock.js';

function session(seed: number): string {
  return writeStringSession(readStringSession({ testMode: true, authKey: new Uint8Array(256).fill(seed) }));
}

test('pruning recognizes definitive SDK RPC auth failures, including invalidated duplicated keys under an exclusive lease', () => {
  for (const text of ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'AUTH_KEY_DUPLICATED'] as const) {
    assert.equal(isDeadTelegramTestSession(new tl.RpcError(401, text)), true, text);
  }
  for (const error of [new tl.RpcError(420, 'FLOOD_WAIT_12'), new Error('AUTH_KEY_UNREGISTERED'), new Error('transport timeout'), { text: 'SESSION_REVOKED' }]) {
    assert.equal(isDeadTelegramTestSession(error), false);
  }
});

test('auth-key lease identity ignores session metadata', () => {
  const original = session(1);
  const changed = writeStringSession({ ...readStringSession(original), self: { userId: 1, isBot: false, isPremium: false, usernames: [] } });
  assert.equal(telegramTestSessionLockName(original), telegramTestSessionLockName(changed));
  assert.notEqual(telegramTestSessionLockName(original), telegramTestSessionLockName(session(2)));
});

test('pruning persists an empty list and later login can recover it without losing unrelated dotenv data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-session-prune-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, '.env');
  await writeFile(filename, `UNRELATED=keep\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([session(1)])}'\n`);
  await withTelegramTestLock('authorization', new AbortController().signal, () => withTelegramTestSessionStorage(filename, async storage => {
    await storage.save([]);
  }));
  assert.deepEqual(JSON.parse(parseEnv(await readFile(filename, 'utf8')).TELEGRAM_TEST_SESSIONS!), []);
  await appendTelegramTestSession(filename, session(2));
  const env = parseEnv(await readFile(filename, 'utf8'));
  assert.equal(env.UNRELATED, 'keep');
  assert.deepEqual(JSON.parse(env.TELEGRAM_TEST_SESSIONS!), [session(2)]);
});
