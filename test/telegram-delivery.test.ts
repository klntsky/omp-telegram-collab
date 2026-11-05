import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TelegramDelivery } from '../src/telegram-delivery.js';

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  return async (ms: number) => {
    await settle();
    t.mock.timers.tick(ms);
    await settle();
  };
}


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

