import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramDelivery } from '../src/telegram-delivery.js';
import { clock } from './delivery-clock.js';

test('typing expires four seconds after enqueue even behind an in-flight message', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<void>();
  const initial = delivery.run(
    1,
    () => gate.promise,
    () => true,
  );
  const pending = delivery.typing(
    1,
    10,
    async () => assert.fail('expired typing'),
    () => true,
  );
  await advance(4000);
  assert.equal(await pending, undefined);
  gate.resolve();
  await initial;
});

test('typing invalidation discards prior refreshes but permits a later fresh refresh', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<void>();
  const initial = delivery.run(
    1,
    () => gate.promise,
    () => true,
  );
  const calls: number[] = [];
  const old = delivery.typing(
    1,
    10,
    async () => {
      calls.push(1);
    },
    () => true,
  );
  const other = delivery.typing(
    1,
    20,
    async () => {
      calls.push(2);
    },
    () => true,
  );
  delivery.invalidateTyping(1, 10);
  assert.equal(await old, undefined);
  const fresh = delivery.typing(
    1,
    10,
    async () => {
      calls.push(3);
    },
    () => true,
  );
  gate.resolve();
  await Promise.all([initial, other, fresh]);
  assert.deepEqual(calls, [2, 3]);
});

test('typing caps topics per chat until sent indicators expire, including inactive topics', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: number[] = [];
  let firstActive = true;
  await delivery.typing(
    1,
    10,
    async () => {
      calls.push(10);
    },
    () => firstActive,
  );
  await delivery.typing(
    1,
    20,
    async () => {
      calls.push(20);
    },
    () => true,
  );
  await delivery.typing(
    1,
    25,
    async () => {
      calls.push(25);
    },
    () => true,
  );
  assert.equal(
    await delivery.typing(
      1,
      30,
      async () => assert.fail('over capacity'),
      () => true,
    ),
    undefined,
  );
  await delivery.typing(
    2,
    30,
    async () => {
      calls.push(230);
    },
    () => true,
  );
  firstActive = false;
  assert.equal(
    await delivery.typing(
      1,
      30,
      async () => assert.fail('inactive indicator still visible'),
      () => true,
    ),
    undefined,
  );
  await advance(4000);
  assert.equal(
    await delivery.typing(
      1,
      40,
      async () => assert.fail('stale indicator still visible'),
      () => true,
    ),
    undefined,
  );
  await advance(1000);
  await delivery.typing(
    1,
    40,
    async () => {
      calls.push(40);
    },
    () => true,
  );
  assert.deepEqual(calls, [10, 20, 25, 230, 40]);
});

test('typing staggers same-topic sends without delaying ready topics or foreground', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: [string, number][] = [];
  await delivery.typing(
    1,
    10,
    async () => {
      calls.push(['first', Date.now()]);
    },
    () => true,
  );
  await advance(1000);
  const refresh = delivery.typing(
    1,
    10,
    async () => {
      calls.push(['refresh', Date.now()]);
    },
    () => true,
  );
  await delivery.typing(
    1,
    20,
    async () => {
      calls.push(['other', Date.now()]);
    },
    () => true,
  );
  await delivery.run(
    1,
    async () => {
      calls.push(['foreground', Date.now()]);
    },
    () => true,
  );
  assert.deepEqual(calls, [
    ['first', 0],
    ['other', 1000],
    ['foreground', 1000],
  ]);
  await advance(2999);
  assert.equal(calls.length, 3);
  await advance(1);
  await refresh;
  assert.deepEqual(calls.at(-1), ['refresh', 4000]);
});


test('typing failures retain diagnostics and inactive or closed typing resolves without sending', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const failure = new Error('Operation failed\nOriginal diagnostic');
  await assert.rejects(
    delivery.typing(
      1,
      10,
      async () => {
        throw failure;
      },
      () => true,
    ),
    (error) => error === failure,
  );
  await assert.rejects(
    delivery.typing(
      1,
      20,
      async () => {},
      () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(
    await delivery.typing(
      1,
      20,
      async () => assert.fail('inactive typing'),
      () => false,
    ),
    undefined,
  );
  const gate = Promise.withResolvers<void>();
  const initial = delivery.run(
    1,
    () => gate.promise,
    () => true,
  );
  const queued = delivery.typing(
    1,
    20,
    async () => assert.fail('closed typing'),
    () => true,
  );
  delivery.close();
  assert.equal(await queued, undefined);
  assert.equal(
    await delivery.typing(
      1,
      30,
      async () => assert.fail('after close'),
      () => true,
    ),
    undefined,
  );
  gate.resolve();
  await initial;
});

test('typing rechecks queued activity and preserves staggering across inactive admission reclamation', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  let active = true;
  const starts: number[] = [];
  await delivery.typing(
    1,
    10,
    async () => {
      starts.push(Date.now());
    },
    () => active,
  );
  await advance(1000);
  const canceled = delivery.typing(
    1,
    10,
    async () => assert.fail('inactive refresh'),
    () => active,
  );
  active = false;
  await delivery.typing(
    1,
    20,
    async () => {},
    () => true,
  );
  assert.equal(await canceled, undefined);
  const refreshed = delivery.typing(
    1,
    10,
    async () => {
      starts.push(Date.now());
    },
    () => true,
  );
  await advance(2999);
  assert.deepEqual(starts, [0]);
  await advance(1);
  await refreshed;
  assert.deepEqual(starts, [0, 4000]);
});

