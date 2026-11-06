import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { test } from 'node:test';
import { TelegramDelivery } from '../src/telegram-delivery.js';
import { clock } from './delivery-clock.js';

test('topic lanes start independently of held ordinary and name requests', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const calls: string[] = [];
  const ordinary = delivery.run(
    1,
    () => {
      calls.push('ordinary');
      return held.promise;
    },
    () => true,
  );
  const name = delivery.runTopic(
    1,
    'name',
    'a',
    () => {
      calls.push('name');
      return held.promise;
    },
    () => true,
  );
  const icon = delivery.runTopic(
    1,
    'icon',
    'a',
    async (signal) => {
      assert.equal(typeof signal.addEventListener, 'function');
      calls.push('icon');
      return 'applied';
    },
    () => true,
  );
  assert.equal(await icon, 'applied');
  assert.deepEqual(calls, ['ordinary', 'name', 'icon']);
  held.resolve();
  await Promise.all([ordinary, name]);
});


test('topic pending keys coalesce while preserving FIFO across topics and caller retries', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const first = delivery.runTopic(
    1,
    'name',
    'held',
    () => held.promise,
    () => true,
  );
  const calls: string[] = [];
  const old = delivery.runTopic(
    1,
    'name',
    'a',
    async () => {
      calls.push('obsolete');
    },
    () => true,
  );
  const b = delivery.runTopic(
    1,
    'name',
    'b',
    async () => {
      calls.push('b');
    },
    () => true,
  );
  const failure = new Error('Operation failed\nOriginal diagnostic');
  const latest = delivery.runTopic(
    1,
    'name',
    'a',
    async () => {
      calls.push('latest');
      throw failure;
    },
    () => true,
  );
  const failed = assert.rejects(latest, (error) => error === failure);
  assert.equal(await old, undefined);
  held.resolve();
  await first;
  await failed;
  const retry = delivery.runTopic(
    1,
    'name',
    'a',
    async () => {
      calls.push('retry');
    },
    () => true,
  );
  await Promise.all([b, retry]);
  assert.deepEqual(calls, ['latest', 'b', 'retry']);
});

test('topic admission rechecks stale queued eligibility and preserves thrown errors', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const first = delivery.runTopic(
    1,
    'icon',
    'held',
    () => held.promise,
    () => true,
  );
  let active = true;
  const stale = delivery.runTopic(
    1,
    'icon',
    'stale',
    async () => assert.fail('stale side effect'),
    () => active,
  );
  const failure = new Error('Operation failed\nOriginal diagnostic');
  const bad = delivery.runTopic(
    1,
    'icon',
    'bad',
    async () => {
      throw failure;
    },
    () => true,
  );
  const rejected = assert.rejects(bad, (error) => error === failure);
  active = false;
  held.resolve();
  await first;
  assert.equal(await stale, undefined);
  await rejected;
  assert.equal(
    await delivery.runTopic(
      1,
      'icon',
      'next',
      async () => 'side effect',
      () => true,
    ),
    'side effect',
  );
});


test('close aborts running topic requests and cancels coalesced work without replay', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  const raw = Promise.withResolvers<void>();
  let aborted = false;
  const pending = delivery.runTopic(
    1,
    'icon',
    'a',
    (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return raw.promise;
    },
    () => true,
  );
  const queued = delivery.runTopic(
    1,
    'icon',
    'b',
    async () => assert.fail('closed side effect'),
    () => true,
  );
  await settle();
  delivery.close();
  assert.deepEqual(await Promise.all([pending, queued]), [undefined, undefined]);
  assert.equal(aborted, true);
  raw.reject(new Error('Operation failed after close'));
  await advance(10000);
  assert.equal(
    await delivery.runTopic(
      1,
      'name',
      'c',
      async () => assert.fail('reopened side effect'),
      () => true,
    ),
    undefined,
  );
});


