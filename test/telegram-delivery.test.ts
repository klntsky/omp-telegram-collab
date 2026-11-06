import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { test } from 'node:test';
import { TelegramDelivery } from '../src/telegram-delivery.js';
import { clock } from './delivery-clock.js';

test('delivery serializes each chat without delaying starts or blocking other chats', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<string>();
  const starts: [string, number][] = [];
  const first = delivery.run(
    1,
    () => {
      starts.push(['first', Date.now()]);
      return gate.promise;
    },
    () => true,
  );
  const second = delivery.run(
    1,
    async () => {
      starts.push(['second', Date.now()]);
      return 2;
    },
    () => true,
  );
  const other = delivery.run(
    2,
    async () => {
      starts.push(['other', Date.now()]);
      return 3;
    },
    () => true,
  );
  await settle();
  assert.deepEqual(starts, [
    ['first', 0],
    ['other', 0],
  ]);
  assert.equal(await other, 3);
  await advance(1500);
  assert.deepEqual(starts, [
    ['first', 0],
    ['other', 0],
  ]);
  gate.resolve('sent');
  assert.equal(await first, 'sent');
  assert.equal(await second, 2);
  assert.deepEqual(starts, [
    ['first', 0],
    ['other', 0],
    ['second', 1500],
  ]);
  const third = delivery.run(
    1,
    async () => {
      starts.push(['third', Date.now()]);
      return 4;
    },
    () => true,
  );
  assert.equal(await third, 4);
  assert.deepEqual(starts.at(-1), ['third', 1500]);
});



test('operation failures reject once without poisoning the queue', async t => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const failure = new Error('Operation failed\nOriginal diagnostic');
  let attempts = 0;
  const pending = delivery.run(1, async () => { attempts++; throw failure; }, () => true);
  const rejected = assert.rejects(pending, error => error === failure);
  const following = delivery.run(1, async () => 'next', () => true);
  await rejected;
  assert.equal(await following, 'next');
  assert.equal(attempts, 1);
});

test('inactive jobs cancel without running their operations', async t => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: string[] = [];
  assert.equal(await delivery.run(1, async () => { calls.push('inactive'); }, () => false), undefined);
  const gate = Promise.withResolvers<void>();
  const initial = delivery.run(1, async () => {
    await gate.promise;
    calls.push('initial');
  }, () => true);
  let active = true;
  const canceled = delivery.run(1, async () => { calls.push('canceled'); }, () => active);
  const following = delivery.run(1, async () => { calls.push('following'); return 'sent'; }, () => true);
  await settle();
  active = false;
  gate.resolve();
  await initial;
  assert.equal(await canceled, undefined);
  assert.equal(await following, 'sent');
  assert.deepEqual(calls, ['initial', 'following']);
});


test('shutdown cancels queued jobs without muting in-flight operation failures', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<string>();
  const failure = new Error('Operation failed after close\nOriginal diagnostic');
  let attempts = 0;
  const pending = delivery.run(
    1,
    () => {
      attempts++;
      return gate.promise;
    },
    () => true,
  );
  const queued = delivery.run(
    1,
    async () => assert.fail('closed job must not run'),
    () => true,
  );
  await settle();
  delivery.close();
  assert.equal(await queued, undefined);
  gate.reject(failure);
  await assert.rejects(pending, error => error === failure);
  await settle();
  assert.equal(attempts, 1);
});

test('pure eligibility failures preserve the original exception and release each real lane', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const failure = new Error('eligibility diagnostic');
  for (const lane of ['ordinary', 'name', 'icon'] as const) {
    const active = () => {
      throw failure;
    };
    const action = async () => assert.fail('ineligible request');
    const rejected =
      lane === 'ordinary'
        ? delivery.run(1, action, active)
        : delivery.runTopic(1, lane, 'failed', action, active);
    await assert.rejects(rejected, (error) => error === failure);
    const following =
      lane === 'ordinary'
        ? delivery.run(
            1,
            async () => 'sent',
            () => true,
          )
        : delivery.runTopic(
            1,
            lane,
            'next',
            async () => 'sent',
            () => true,
          );
    assert.equal(await following, 'sent');
  }
});
