import assert from 'node:assert/strict';
import test from 'node:test';
import { teardownTelegramTestResources } from './e2e/helpers/telegram-fixture.js';

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
