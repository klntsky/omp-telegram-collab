import assert from 'node:assert/strict';
import test from 'node:test';
import { teardownTelegramTestResources } from './e2e/helpers/telegram-fixture.js';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { TelegramClient } from '@mtcute/node';
import { TelegramTestExecution } from '../scripts/lib/telegram-test-sessions.js';
import { acquireTelegramTestLock } from '../scripts/lib/telegram-test-lock.js';

function ownedExecution(t: TestContext) {
  const key = `test-execution-key:${randomUUID()}`;
  const client = {} as TelegramClient;
  const execution = new TelegramTestExecution(async signal => {
    const release = await acquireTelegramTestLock(key, signal);
    return { client, close: release! };
  });
  t.after(() => execution.close());
  return { key, client, execution };
}

async function assertOwned(key: string, owned: boolean, signal: AbortSignal) {
  const release = await acquireTelegramTestLock(key, signal, true);
  assert.equal(release === undefined, owned);
  await release?.();
}

test('bot lease is released after forum cleanup and before the independent user disconnects', async () => {
  const calls: string[] = [];
  await teardownTelegramTestResources({
    user: { async close() { calls.push('disconnect'); } },
    lease: { async release() { calls.push('release'); } },
    forumSetup: Promise.resolve({ async close() { calls.push('forum'); } }),
  });
  assert.deepEqual(calls, ['forum', 'release', 'disconnect']);
});

test('unsettled or failed poller retains lease ownership even when its user disconnects', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  await assert.rejects(teardownTelegramTestResources({
    user: { async close() { controller.abort(); calls.push('disconnect'); } },
    lease: { async release() { calls.push('release'); } },
    canReleaseBot: () => false,
  }), Error);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(calls, ['disconnect']);
});

test('lease release failure preserves its original diagnostic and disconnects', async () => {
  const failure = new Error('Original lease release diagnostic');
  let closed = false;
  await assert.rejects(teardownTelegramTestResources({
    user: { async close() { closed = true; } },
    lease: { async release() { throw failure; } },
  }), error => error === failure);
  assert.equal(closed, true);
});

test('forum cleanup failure does not prevent lease release after polling has stopped', async () => {
  const failure = new Error('Original forum cleanup diagnostic');
  const calls: string[] = [];
  await assert.rejects(teardownTelegramTestResources({
    user: { async close() { calls.push('disconnect'); } },
    lease: { async release() { calls.push('release'); } },
    forumSetup: Promise.resolve({ async close() { throw failure; } }),
  }), error => error === failure);
  assert.deepEqual(calls, ['release', 'disconnect']);
});

test('lease ownership is retained while asynchronous forum teardown is pending', async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const calls: string[] = [];
  const cleanup = teardownTelegramTestResources({
    user: { async close() { calls.push('disconnect'); } },
    lease: { async release() { calls.push('release'); } },
    forumSetup: Promise.resolve({ async close() { entered.resolve(); await finish.promise; calls.push('forum'); } }),
  });
  await entered.promise;
  assert.deepEqual(calls, []);
  finish.resolve();
  await cleanup;
  assert.deepEqual(calls, ['forum', 'release', 'disconnect']);
});

test('cancelled setup without an acquired lease still closes the independent user', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Setup cancelled before acquiring a bot'));
  let closed = false;
  await teardownTelegramTestResources({ user: { async close() {
    assert.equal(controller.signal.aborted, true);
    closed = true;
  } } });
  assert.equal(closed, true);
});

test('sequential fixtures retain one authorization until their execution closes', { timeout: 15000 }, async t => {
  const { key, client, execution } = ownedExecution(t);
  const first = await execution.acquire(t.signal);
  t.after(() => first.close());
  await first.close();
  await assertOwned(key, true, t.signal);
  const second = await execution.acquire(t.signal);
  t.after(() => second.close());
  assert.equal(second.client, client);
  assert.equal(second.client, first.client);
  await second.close();
  await execution.close();
  await assertOwned(key, false, t.signal);
  await assert.rejects(execution.acquire(t.signal), error => error instanceof Error);
});

test('parallel executions keep distinct authorizations and cancellation cannot release another fixture', { timeout: 15000 }, async t => {
  const left = ownedExecution(t);
  const right = ownedExecution(t);
  const [first, other] = await Promise.all([left.execution.acquire(t.signal), right.execution.acquire(t.signal)]);
  t.after(() => first.close());
  t.after(() => other.close());
  assert.notEqual(first.client, other.client);
  const controller = new AbortController();
  const reason = new Error('Cancelled fixture waiting for its execution');
  const waiting = left.execution.acquire(controller.signal);
  const cancelled = assert.rejects(waiting, error => error === reason);
  await setImmediate();
  controller.abort(reason);
  await cancelled;
  await assertOwned(left.key, true, t.signal);
  await assertOwned(right.key, true, t.signal);
  await first.close();
  const next = await left.execution.acquire(t.signal);
  t.after(() => next.close());
  assert.equal(next.client, first.client);
  await next.close();
  await other.close();
});

test('failed authorization is not replayed by another fixture in the same execution', { timeout: 15000 }, async t => {
  const failure = new Error('Original ambiguous authorization failure');
  let attempts = 0;
  const execution = new TelegramTestExecution(async () => { attempts++; throw failure; });
  await assert.rejects(execution.acquire(t.signal), error => error === failure);
  await assert.rejects(execution.acquire(t.signal), error => error === failure);
  assert.equal(attempts, 1);
  await assert.rejects(execution.close(), error => error === failure);
});

test('execution shutdown owns and closes a late authorization result', { timeout: 15000 }, async t => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const key = `test-execution-key:${randomUUID()}`;
  const execution = new TelegramTestExecution(async signal => {
    const release = await acquireTelegramTestLock(key, signal);
    entered.resolve();
    await finish.promise;
    return { client: {} as TelegramClient, close: release! };
  });
  const pending = execution.acquire(t.signal);
  const rejected = assert.rejects(pending, error => error instanceof Error);
  await entered.promise;
  const closing = execution.close();
  finish.resolve();
  await rejected;
  await closing;
  await assertOwned(key, false, t.signal);
});
