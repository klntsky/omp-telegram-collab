import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { GrammyError, HttpError } from 'grammy';
import { TelegramDelivery } from '../src/telegram-delivery.js';

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  return async (ms: number) => {
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


test('explicit 429 retains the active question through repeated chat-wide cooldowns', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: [string, number][] = [];
  let attempts = 0;
  const question = delivery.run(1, async () => {
    calls.push(['question', Date.now()]);
    attempts++;
    if (attempts === 1) throw limited(3);
    if (attempts === 2) throw limited(2);
    return 'question delivered';
  }, () => true);
  const following = delivery.run(1, async () => { calls.push(['following', Date.now()]); }, () => true);
  await settle();
  await delivery.run(2, async () => { calls.push(['other-chat', Date.now()]); }, () => true);
  await advance(2999);
  assert.deepEqual(calls, [['question', 0], ['other-chat', 0]]);
  await advance(1);
  assert.deepEqual(calls.at(-1), ['question', 3000]);
  await advance(1999);
  assert.equal(attempts, 2);
  await advance(1);
  assert.equal(await question, 'question delivered');
  await following;
  assert.deepEqual(calls, [
    ['question', 0], ['other-chat', 0], ['question', 3000],
    ['question', 5000], ['following', 5000],
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

test('close aborts cooldown and resolves every pending job without waiting or later delivery', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: string[] = [];
  const retrying = delivery.run(1, async () => { calls.push('limited'); throw limited(60); }, () => true);
  const question = delivery.run(1, async () => { calls.push('question'); }, () => true);
  await settle();
  const icon = delivery.runTopic(1, 'icon', 'topic', async () => { calls.push('icon'); }, () => true);
  delivery.close();
  delivery.close();
  assert.deepEqual(await Promise.all([retrying, question, icon]), [undefined, undefined, undefined]);
  assert.equal(await delivery.run(2, async () => { calls.push('after-close'); }, () => true), undefined);
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
  delivery.close();
  assert.equal(await queued, undefined);
  gate.reject(limited(60));
  assert.equal(await pending, undefined);
  await settle();
  assert.equal(attempts, 1);
});

test('topic lanes start independently of held ordinary and name requests', async t => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const calls: string[] = [];
  const ordinary = delivery.run(1, () => { calls.push('ordinary'); return held.promise; }, () => true);
  const name = delivery.runTopic(1, 'name', 'a', () => { calls.push('name'); return held.promise; }, () => true);
  const icon = delivery.runTopic(1, 'icon', 'a', async signal => {
    assert.equal(typeof signal.addEventListener, 'function');
    calls.push('icon');
    return 'applied';
  }, () => true);
  assert.equal(await icon, 'applied');
  assert.deepEqual(calls, ['ordinary', 'name', 'icon']);
  held.resolve();
  await Promise.all([ordinary, name]);
});

test('topic 429 rejects the original error and gates all lanes but not other chats', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const error = limited(2);
  let attempts = 0;
  await assert.rejects(delivery.runTopic(1, 'name', 'a', async () => { attempts++; throw error; }, () => true), value => value === error);
  const calls: string[] = [];
  const ordinary = delivery.run(1, async () => { calls.push('ordinary'); }, () => true);
  const name = delivery.runTopic(1, 'name', 'b', async () => { calls.push('name'); }, () => true);
  const icon = delivery.runTopic(1, 'icon', 'a', async () => { calls.push('icon'); }, () => true);
  await delivery.runTopic(2, 'icon', 'a', async () => { calls.push('other'); }, () => true);
  await advance(1999);
  assert.deepEqual(calls, ['other']);
  await advance(1);
  await Promise.all([ordinary, name, icon]);
  assert.deepEqual(calls, ['other', 'ordinary', 'name', 'icon']);
  assert.equal(attempts, 1);
});

test('topic pending keys coalesce while preserving FIFO across topics and caller retries', async t => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const first = delivery.runTopic(1, 'name', 'held', () => held.promise, () => true);
  const calls: string[] = [];
  const old = delivery.runTopic(1, 'name', 'a', async () => { calls.push('obsolete'); }, () => true);
  const b = delivery.runTopic(1, 'name', 'b', async () => { calls.push('b'); }, () => true);
  const latest = delivery.runTopic(1, 'name', 'a', async () => { calls.push('latest'); throw limited(0); }, () => true);
  const failed = assert.rejects(latest, error => error instanceof GrammyError);
  assert.equal(await old, undefined);
  held.resolve();
  await first;
  await failed;
  const retry = delivery.runTopic(1, 'name', 'a', async () => { calls.push('retry'); }, () => true);
  await Promise.all([b, retry]);
  assert.deepEqual(calls, ['latest', 'b', 'retry']);
});

test('topic admission rechecks stale queued eligibility and preserves thrown errors', async t => {
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const held = Promise.withResolvers<void>();
  const first = delivery.runTopic(1, 'icon', 'held', () => held.promise, () => true);
  let active = true;
  const stale = delivery.runTopic(1, 'icon', 'stale', async () => assert.fail('stale side effect'), () => active);
  const failure = new HttpError('original transport diagnostic', new Error('socket'));
  const bad = delivery.runTopic(1, 'icon', 'bad', async () => { throw failure; }, () => true);
  const rejected = assert.rejects(bad, error => error === failure);
  active = false;
  held.resolve();
  await first;
  assert.equal(await stale, undefined);
  await rejected;
  assert.equal(await delivery.runTopic(1, 'icon', 'next', async () => 'side effect', () => true), 'side effect');
});

test('topic timeout aborts locally and observes late 429 before admitting any lane', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const raw = Promise.withResolvers<void>();
  let aborted = false;
  const pending = delivery.runTopic(1, 'name', 'slow', signal => {
    signal.addEventListener('abort', () => { aborted = true; });
    return raw.promise;
  }, () => true);
  const timeout = assert.rejects(pending, /timed out after 5000ms/);
  await advance(5000);
  await timeout;
  assert.equal(aborted, true);
  raw.reject(limited(3));
  await settle();
  const calls: string[] = [];
  const ordinary = delivery.run(1, async () => { calls.push('ordinary'); }, () => true);
  const name = delivery.runTopic(1, 'name', 'next', async () => { calls.push('name'); }, () => true);
  const icon = delivery.runTopic(1, 'icon', 'next', async () => { calls.push('icon'); }, () => true);
  await advance(2999);
  assert.deepEqual(calls, []);
  await advance(1);
  await Promise.all([ordinary, name, icon]);
  assert.deepEqual(calls, ['ordinary', 'name', 'icon']);
});

test('close aborts running topic requests and cancels coalesced work without replay', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  const raw = Promise.withResolvers<void>();
  let aborted = false;
  const pending = delivery.runTopic(1, 'icon', 'a', signal => {
    signal.addEventListener('abort', () => { aborted = true; });
    return raw.promise;
  }, () => true);
  const queued = delivery.runTopic(1, 'icon', 'b', async () => assert.fail('closed side effect'), () => true);
  delivery.close();
  assert.deepEqual(await Promise.all([pending, queued]), [undefined, undefined]);
  assert.equal(aborted, true);
  raw.reject(limited(3));
  await advance(10000);
  assert.equal(await delivery.runTopic(1, 'name', 'c', async () => assert.fail('reopened side effect'), () => true), undefined);
});

test('ordinary 429 cooldown gates both metadata lanes without blocking another chat', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  let attempts = 0;
  const ordinary = delivery.run(1, async () => {
    if (++attempts === 1) throw limited(2);
  }, () => true);
  await settle();
  const calls: string[] = [];
  const name = delivery.runTopic(1, 'name', 'a', async () => { calls.push('name'); }, () => true);
  const icon = delivery.runTopic(1, 'icon', 'a', async () => { calls.push('icon'); }, () => true);
  await delivery.run(2, async () => { calls.push('other'); }, () => true);
  await advance(1999);
  assert.deepEqual(calls, ['other']);
  await advance(1);
  await Promise.all([ordinary, name, icon]);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['other', 'name', 'icon']);
});

for (const outcome of ['true', 'false', 'throw'] as const) {
  test(`reentrant same-key replacement survives an eligibility callback returning ${outcome}`, async t => {
    const delivery = new TelegramDelivery();
    t.after(() => delivery.close());
    const calls: string[] = [];
    let replacement: Promise<string | undefined> | undefined;
    const old = delivery.runTopic(1,'icon','same',async () => { calls.push('obsolete'); },() => {
      replacement = delivery.runTopic(1,'icon','same',async () => { calls.push('replacement'); return 'sent'; },() => true);
      if (outcome === 'throw') throw new Error('Replaced eligibility failed');
      return outcome === 'true';
    });
    await settle();
    assert.deepEqual(calls,['replacement']);
    assert.equal(await old,undefined);
    assert.equal(await replacement,'sent');
  });
}

for (const outcome of ['false', 'throw'] as const) {
  test(`reentrant admission revisits earlier lanes after eligibility returns ${outcome}`, async t => {
    const delivery = new TelegramDelivery();
    t.after(() => delivery.close());
    const calls: string[] = [];
    const failure = new Error('Eligibility failed after enqueue');
    let ordinary: Promise<string | undefined> | undefined;
    const icon = delivery.runTopic(1,'icon','same',async () => assert.fail('Ineligible icon dispatched'),() => {
      ordinary = delivery.run(1,async () => { calls.push('ordinary'); return 'sent'; },() => true);
      if (outcome === 'throw') throw failure;
      return false;
    });
    if (outcome === 'throw') await assert.rejects(icon,error => error === failure);
    else assert.equal(await icon,undefined);
    await settle();
    assert.deepEqual(calls,['ordinary']);
    assert.equal(await ordinary,'sent');
  });
}

test('reentrant eligibility yields to a shared cooldown before both lanes resume', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  await assert.rejects(delivery.runTopic(1,'name','limited',async () => { throw limited(1); },() => true));
  const calls: string[] = [];
  let budget = 100;
  let icon: Promise<void | undefined> | undefined;
  const ordinary = delivery.run(1,async () => { calls.push('ordinary'); return 'sent'; },() => {
    if (--budget === 0) throw new Error('Eligibility spun without yielding to the cooldown');
    icon = delivery.runTopic(1,'icon','same',async () => { calls.push('icon'); },() => true);
    return true;
  });
  const outcome = ordinary.then(value => ({value}),error => ({error}));
  await settle();
  assert.deepEqual(calls,[]);
  await advance(1000);
  assert.deepEqual(await outcome,{value:'sent'});
  await icon;
  assert.deepEqual(calls,['ordinary','icon']);
});
