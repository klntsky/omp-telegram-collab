import assert from 'node:assert/strict';
import test from 'node:test';
import { teardownTelegramTestResources } from './e2e/helpers/telegram-fixture.js';

test('disposable bot is deleted before the independent user disconnects', async () => {
  const calls: string[] = [];
  await teardownTelegramTestResources({
    user: {
      async deleteBot(token) { assert.equal(token, 'disposable'); calls.push('delete'); },
      async close() { calls.push('disconnect'); },
    },
    token: 'disposable',
    forumSetup: Promise.resolve({ async close() { calls.push('forum'); } }),
  });
  assert.deepEqual(calls, ['forum', 'delete', 'disconnect']);
});

test('unsettled or failed poller retains the bot and disconnects its user', async () => {
  const calls: string[] = [];
  await assert.rejects(teardownTelegramTestResources({
    user: {
      async deleteBot() { calls.push('delete'); },
      async close() { calls.push('disconnect'); },
    },
    token: 'disposable',
    canDeleteBot: () => false,
  }), Error);
  assert.deepEqual(calls, ['disconnect']);
});

test('ambiguous deletion preserves its original diagnostic and disconnects', async () => {
  const failure = new Error('Original Telegram deletion diagnostic');
  let closed = false;
  await assert.rejects(teardownTelegramTestResources({
    user: {
      async deleteBot() { throw failure; },
      async close() { closed = true; },
    },
    token: 'disposable',
  }), error => error === failure);
  assert.equal(closed, true);
});

test('forum cleanup failure does not prevent deletion after polling has stopped', async () => {
  const failure = new Error('Original forum cleanup diagnostic');
  const calls: string[] = [];
  await assert.rejects(teardownTelegramTestResources({
    user: {
      async deleteBot() { calls.push('delete'); },
      async close() { calls.push('disconnect'); },
    },
    token: 'disposable',
    forumSetup: Promise.resolve({ async close() { throw failure; } }),
  }), error => error === failure);
  assert.deepEqual(calls, ['delete', 'disconnect']);
});
