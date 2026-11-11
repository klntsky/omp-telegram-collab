import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { test } from 'node:test';
import { TelegramDelivery } from '../src/telegram-delivery.js';
import { clock } from './delivery-clock.js';

test('typing waits for ordinary, name, and icon lanes and replaces queued same-topic refreshes', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const ordinaryGate = Promise.withResolvers<void>();
  const nameGate = Promise.withResolvers<void>();
  const iconGate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const initial = delivery.run(
    1,
    () => {
      calls.push('ordinary');
      return ordinaryGate.promise;
    },
    () => true,
  );
  const name = delivery.runTopic(
    1,
    'name',
    'a',
    () => {
      calls.push('name');
      return nameGate.promise;
    },
    () => true,
  );
  const icon = delivery.runTopic(
    1,
    'icon',
    'a',
    () => {
      calls.push('icon');
      return iconGate.promise;
    },
    () => true,
  );
  const old = delivery.typing(
    1,
    10,
    async () => {
      calls.push('old');
    },
    () => true,
  );
  const fresh = delivery.typing(
    1,
    10,
    async () => {
      calls.push('typing');
    },
    () => true,
  );
  const foreground = delivery.run(
    1,
    async () => {
      calls.push('foreground');
    },
    () => true,
  );
  assert.equal(await old, undefined);
  assert.deepEqual(calls, ['ordinary', 'name', 'icon']);
  ordinaryGate.resolve();
  await Promise.all([initial, foreground]);
  await advance(1000);
  assert.deepEqual(calls, ['ordinary', 'name', 'icon', 'foreground']);
  nameGate.resolve();
  await name;
  await advance(1000);
  assert.deepEqual(calls, ['ordinary', 'name', 'icon', 'foreground']);
  iconGate.resolve();
  await Promise.all([icon, fresh]);
  assert.deepEqual(calls, ['ordinary', 'name', 'icon', 'foreground', 'typing']);
});

test('in-flight typing does not block newly arriving ordinary, name, or icon output', async (t) => {
  clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const typing = delivery.typing(
    1,
    10,
    () => {
      calls.push('typing');
      return gate.promise;
    },
    () => true,
  );
  await settle();
  const nextTyping = delivery.typing(
    1,
    20,
    async () => {
      calls.push('next-typing');
    },
    () => true,
  );
  const ordinary = delivery.run(
    1,
    async () => {
      calls.push('ordinary');
      return 'message';
    },
    () => true,
  );
  const name = delivery.runTopic(
    1,
    'name',
    'a',
    async () => {
      calls.push('name');
      return 'name applied';
    },
    () => true,
  );
  const icon = delivery.runTopic(
    1,
    'icon',
    'a',
    async () => {
      calls.push('icon');
      return 'icon applied';
    },
    () => true,
  );
  assert.deepEqual(await Promise.all([ordinary, name, icon]), [
    'message',
    'name applied',
    'icon applied',
  ]);
  assert.deepEqual(calls, ['typing', 'ordinary', 'name', 'icon']);
  gate.resolve();
  await Promise.all([typing, nextTyping]);
  assert.deepEqual(calls, ['typing', 'ordinary', 'name', 'icon', 'next-typing']);
});

test('coalesced admission gives real output priority over pending typing in the same turn', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const calls: string[] = [];
  const typing = delivery.typing(
    1,
    10,
    async () => {
      calls.push('typing');
    },
    () => true,
  );
  const output = delivery.run(
    1,
    () => {
      calls.push('ordinary');
      return held.promise;
    },
    () => true,
  );
  await settle();
  assert.deepEqual(calls, ['ordinary']);
  held.resolve();
  await Promise.all([output, typing]);
  assert.deepEqual(calls, ['ordinary', 'typing']);
});
