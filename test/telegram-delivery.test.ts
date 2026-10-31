import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { GrammyError, HttpError } from 'grammy';
import { TelegramDelivery } from '../src/telegram-delivery.js';

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  return async (ms: number) => {
    await settle();
    t.mock.timers.tick(ms);
    await settle();
  };
}

function limited(seconds?: number) {
  return new GrammyError('Rate limited', {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests',
    parameters: seconds === undefined ? undefined : { retry_after: seconds },
  }, 'sendMessage', {});
}

test('delivery serializes each chat without delaying starts or blocking other chats', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<string>();
  const starts: [string, number][] = [];
  const first = delivery.run(1, () => {
    starts.push(['first', Date.now()]);
    return gate.promise;
  }, () => true);
  const second = delivery.run(1, async () => {
    starts.push(['second', Date.now()]);
    return 2;
  }, () => true);
  const other = delivery.run(2, async () => {
    starts.push(['other', Date.now()]);
    return 3;
  }, () => true);
  await settle();
  assert.deepEqual(starts, [['first', 0], ['other', 0]]);
  assert.equal(await other, 3);
  await advance(1500);
  assert.deepEqual(starts, [['first', 0], ['other', 0]]);
  gate.resolve('sent');
  assert.equal(await first, 'sent');
  assert.equal(await second, 2);
  assert.deepEqual(starts, [['first', 0], ['other', 0], ['second', 1500]]);
  const third = delivery.run(1, async () => {
    starts.push(['third', Date.now()]);
    return 4;
  }, () => true);
  assert.equal(await third, 4);
  assert.deepEqual(starts.at(-1), ['third', 1500]);
});


test('explicit 429 retains the active question through repeated chat-wide cooldowns', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: [string, number][] = [];
  let attempts = 0;
  const question = delivery.run(
    1,
    async () => {
      calls.push(['question', Date.now()]);
      attempts++;
      if (attempts === 1) throw limited(3);
      if (attempts === 2) throw limited(2);
      return 'question delivered';
    },
    () => true,
  );
  const following = delivery.run(
    1,
    async () => {
      calls.push(['following', Date.now()]);
    },
    () => true,
  );
  await settle();
  await delivery.run(
    2,
    async () => {
      calls.push(['other-chat', Date.now()]);
    },
    () => true,
  );
  await advance(2999);
  assert.deepEqual(calls, [
    ['question', 0],
    ['other-chat', 0],
  ]);
  await advance(1);
  assert.deepEqual(calls.at(-1), ['question', 3000]);
  await advance(1999);
  assert.equal(attempts, 2);
  await advance(1);
  assert.equal(await question, 'question delivered');
  await following;
  assert.deepEqual(calls, [
    ['question', 0],
    ['other-chat', 0],
    ['question', 3000],
    ['question', 5000],
    ['following', 5000],
  ]);
});


test('a 429 without retry_after waits five seconds before retrying', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const starts: number[] = [];
  await delivery.run(1, async () => { starts.push(Date.now()); }, () => true);
  let attempts = 0;
  const pending = delivery.run(1, async () => {
    starts.push(Date.now());
    if (++attempts === 1) throw limited();
    return 'sent';
  }, () => true);
  await settle();
  assert.deepEqual(starts, [0, 0]);
  await advance(4999);
  assert.equal(attempts, 1);
  await advance(1);
  assert.equal(await pending, 'sent');
  assert.deepEqual(starts, [0, 0, 5000]);
});

test('non-429 Telegram errors and uncertain network failures reject once without poisoning the queue', async t => {
  const advance = clock(t);
  const failures = [
    new GrammyError('Bad request', { ok: false, error_code: 400, description: 'Bad Request' }, 'sendMessage', {}),
    new GrammyError('Server error', { ok: false, error_code: 500, description: 'Internal Server Error' }, 'sendMessage', {}),
    new HttpError('Connection reset after sending the request', new Error('ECONNRESET')),
    Object.assign(new Error('Not an explicit Telegram response'), { error_code: 429, parameters: { retry_after: 1 } }),
  ];
  for (const failure of failures) {
    const delivery = new TelegramDelivery();
    t.after(() => delivery.close());
    let attempts = 0;
    const pending = delivery.run(1, async () => { attempts++; throw failure; }, () => true);
    const rejected = assert.rejects(pending, error => error === failure);
    const following = delivery.run(1, async () => 'next', () => true);
    await rejected;
    await advance(1000);
    assert.equal(await following, 'next');
    await advance(10000);
    assert.equal(attempts, 1);
    delivery.close();
  }
});

test('inactive jobs cancel without API calls, including after a cooldown', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: string[] = [];
  assert.equal(await delivery.run(1, async () => { calls.push('inactive'); }, () => false), undefined);
  let attempts = 0;
  const initial = delivery.run(1, async () => {
    if (++attempts === 1) throw limited(1);
    calls.push('initial');
  }, () => true);
  let active = true;
  const canceled = delivery.run(1, async () => { calls.push('canceled'); }, () => active);
  const following = delivery.run(1, async () => { calls.push('following'); return 'sent'; }, () => true);
  await settle();
  active = false;
  await advance(1000);
  await initial;
  assert.equal(await canceled, undefined);
  assert.equal(await following, 'sent');
  assert.deepEqual(calls, ['initial', 'following']);
});

test('a question canceled during its 429 cooldown is not retried', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  let active = true;
  let attempts = 0;
  const pending = delivery.run(1, async () => { attempts++; throw limited(3); }, () => active);
  await settle();
  active = false;
  await advance(3000);
  assert.equal(await pending, undefined);
  assert.equal(attempts, 1);
  assert.equal(await delivery.run(1, async () => 'next', () => true), 'next');
});

test('close aborts cooldown and resolves every pending job without waiting or later delivery', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: string[] = [];
  const retrying = delivery.run(
    1,
    async () => {
      calls.push('limited');
      throw limited(60);
    },
    () => true,
  );
  const question = delivery.run(
    1,
    async () => {
      calls.push('question');
    },
    () => true,
  );
  await settle();
  const icon = delivery.runTopic(
    1,
    'icon',
    'topic',
    async () => {
      calls.push('icon');
    },
    () => true,
  );
  delivery.close();
  delivery.close();
  assert.deepEqual(await Promise.all([retrying, question, icon]), [
    undefined,
    undefined,
    undefined,
  ]);
  assert.equal(
    await delivery.run(
      2,
      async () => {
        calls.push('after-close');
      },
      () => true,
    ),
    undefined,
  );
  await advance(60000);
  assert.deepEqual(calls, ['limited']);
});

test('close during an in-flight 429 does not requeue or leave its promise unresolved', async t => {
  clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<string>();
  let attempts = 0;
  const pending = delivery.run(1, () => { attempts++; return gate.promise; }, () => true);
  const queued = delivery.run(1, async () => assert.fail('closed job must not run'), () => true);
  await settle();
  delivery.close();
  assert.equal(await queued, undefined);
  gate.reject(limited(60));
  assert.equal(await pending, undefined);
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

test('topic 429 rejects the original error and gates all lanes but not other chats', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const error = limited(2);
  let attempts = 0;
  await assert.rejects(
    delivery.runTopic(
      1,
      'name',
      'a',
      async () => {
        attempts++;
        throw error;
      },
      () => true,
    ),
    (value) => value === error,
  );
  const calls: string[] = [];
  const ordinary = delivery.run(
    1,
    async () => {
      calls.push('ordinary');
    },
    () => true,
  );
  const name = delivery.runTopic(
    1,
    'name',
    'b',
    async () => {
      calls.push('name');
    },
    () => true,
  );
  const icon = delivery.runTopic(
    1,
    'icon',
    'a',
    async () => {
      calls.push('icon');
    },
    () => true,
  );
  await delivery.runTopic(
    2,
    'icon',
    'a',
    async () => {
      calls.push('other');
    },
    () => true,
  );
  await advance(1999);
  assert.deepEqual(calls, ['other']);
  await advance(1);
  await Promise.all([ordinary, name, icon]);
  assert.deepEqual(calls, ['other', 'ordinary', 'name', 'icon']);
  assert.equal(attempts, 1);
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
  const latest = delivery.runTopic(
    1,
    'name',
    'a',
    async () => {
      calls.push('latest');
      throw limited(0);
    },
    () => true,
  );
  const failed = assert.rejects(latest, (error) => error instanceof GrammyError);
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
  const failure = new HttpError('original transport diagnostic', new Error('socket'));
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

test('topic timeout aborts locally and observes late 429 before admitting any lane', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const raw = Promise.withResolvers<void>();
  let aborted = false;
  const pending = delivery.runTopic(
    1,
    'name',
    'slow',
    (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return raw.promise;
    },
    () => true,
  );
  const timeout = assert.rejects(pending, /timed out after 5000ms/);
  await settle();
  await advance(5000);
  await timeout;
  assert.equal(aborted, true);
  raw.reject(limited(3));
  await settle();
  const calls: string[] = [];
  const ordinary = delivery.run(
    1,
    async () => {
      calls.push('ordinary');
    },
    () => true,
  );
  const name = delivery.runTopic(
    1,
    'name',
    'next',
    async () => {
      calls.push('name');
    },
    () => true,
  );
  const icon = delivery.runTopic(
    1,
    'icon',
    'next',
    async () => {
      calls.push('icon');
    },
    () => true,
  );
  await advance(2999);
  assert.deepEqual(calls, []);
  await advance(1);
  await Promise.all([ordinary, name, icon]);
  assert.deepEqual(calls, ['ordinary', 'name', 'icon']);
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
  raw.reject(limited(3));
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

test('ordinary 429 cooldown gates both metadata lanes without blocking another chat', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  let attempts = 0;
  const ordinary = delivery.run(
    1,
    async () => {
      if (++attempts === 1) throw limited(2);
    },
    () => true,
  );
  await settle();
  const calls: string[] = [];
  const name = delivery.runTopic(
    1,
    'name',
    'a',
    async () => {
      calls.push('name');
    },
    () => true,
  );
  const icon = delivery.runTopic(
    1,
    'icon',
    'a',
    async () => {
      calls.push('icon');
    },
    () => true,
  );
  await delivery.run(
    2,
    async () => {
      calls.push('other');
    },
    () => true,
  );
  await advance(1999);
  assert.deepEqual(calls, ['other']);
  await advance(1);
  await Promise.all([ordinary, name, icon]);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['other', 'name', 'icon']);
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

test('typing 429 rejects the original error, sets shared cooldown, and never retries', async (t) => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const failure = limited(5);
  let attempts = 0;
  const pending = delivery.typing(
    1,
    10,
    async () => {
      attempts++;
      throw failure;
    },
    () => true,
  );
  await assert.rejects(pending, (error) => error === failure);
  const calls: number[] = [];
  const question = delivery.run(
    1,
    async () => {
      calls.push(Date.now());
    },
    () => true,
  );
  const expired = delivery.typing(
    1,
    20,
    async () => assert.fail('typing past expiry'),
    () => true,
  );
  await advance(4000);
  assert.equal(await expired, undefined);
  assert.deepEqual(calls, []);
  await advance(1000);
  await question;
  assert.equal(attempts, 1);
  assert.deepEqual(calls, [5000]);
});

test('typing failures retain diagnostics and inactive or closed typing resolves without sending', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const failure = new HttpError('Network failed', new Error('ECONNRESET'));
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
    const active = () => { throw failure; };
    const action = async () => assert.fail('ineligible request');
    const rejected = lane === 'ordinary'
      ? delivery.run(1, action, active)
      : delivery.runTopic(1, lane, 'failed', action, active);
    await assert.rejects(rejected, (error) => error === failure);
    const following = lane === 'ordinary'
      ? delivery.run(1, async () => 'sent', () => true)
      : delivery.runTopic(1, lane, 'next', async () => 'sent', () => true);
    assert.equal(await following, 'sent');
  }
});

test('coalesced admission gives real output priority over pending typing in the same turn', async (t) => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const calls: string[] = [];
  const typing = delivery.typing(1, 10, async () => { calls.push('typing'); }, () => true);
  const output = delivery.run(1, () => {
    calls.push('ordinary');
    return held.promise;
  }, () => true);
  await settle();
  assert.deepEqual(calls, ['ordinary']);
  held.resolve();
  await Promise.all([output, typing]);
  assert.deepEqual(calls, ['ordinary', 'typing']);
});
