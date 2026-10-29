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

test('delivery serializes each chat and spaces starts without blocking other chats', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
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
  assert.deepEqual(starts, [['first', 0], ['other', 0]], 'spacing alone must not allow concurrent calls');
  gate.resolve('sent');
  assert.equal(await first, 'sent');
  assert.equal(await second, 2);
  assert.deepEqual(starts, [['first', 0], ['other', 0], ['second', 1500]]);
  const third = delivery.run(1, async () => {
    starts.push(['third', Date.now()]);
    return 4;
  }, () => true);
  await advance(999);
  assert.equal(starts.length, 3);
  await advance(1);
  assert.equal(await third, 4);
  assert.deepEqual(starts.at(-1), ['third', 2500]);
});

test('spacing is measured between starts rather than after action completion', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
  t.after(() => delivery.close());
  const gate = Promise.withResolvers<void>();
  const starts: number[] = [];
  const first = delivery.run(1, () => {
    starts.push(Date.now());
    return gate.promise;
  }, () => true);
  const second = delivery.run(1, async () => { starts.push(Date.now()); }, () => true);
  await advance(500);
  gate.resolve();
  await first;
  await settle();
  await advance(499);
  assert.deepEqual(starts, [0]);
  await advance(1);
  await second;
  assert.deepEqual(starts, [0, 1000]);
});

test('foreground questions overtake pending icons even after an icon starts waiting for its slot', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
  t.after(() => delivery.close());
  const calls: string[] = [];
  const action = (name: string) => async () => { calls.push(name); };
  await delivery.run(1, action('initial'), () => true, true);
  const firstIcon = delivery.run(1, action('icon-one'), () => true, true);
  await settle();
  const secondIcon = delivery.run(1, action('icon-two'), () => true, true);
  const question = delivery.run(1, action('question'), () => true);
  const edit = delivery.run(1, action('question-edit'), () => true);
  await advance(1000);
  await question;
  assert.deepEqual(calls, ['initial', 'question']);
  await advance(1000);
  await edit;
  assert.deepEqual(calls, ['initial', 'question', 'question-edit']);
  await advance(1000);
  await firstIcon;
  await advance(1000);
  await secondIcon;
  assert.deepEqual(calls, ['initial', 'question', 'question-edit', 'icon-one', 'icon-two']);
});

test('explicit 429 retains the active question through repeated chat-wide cooldowns', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
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
  const icon = delivery.run(1, async () => { calls.push(['icon', Date.now()]); }, () => true, true);
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
  assert.deepEqual(calls.at(-1), ['question', 5000]);
  await advance(1000);
  await following;
  await advance(1000);
  await icon;
  assert.deepEqual(calls, [
    ['question', 0], ['other-chat', 0], ['question', 3000],
    ['question', 5000], ['following', 6000], ['icon', 7000],
  ]);
});

test('a rate-limited icon does not hold a foreground question behind its retry', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
  t.after(() => delivery.close());
  const calls: string[] = [];
  let attempts = 0;
  const icon = delivery.run(1, async () => {
    calls.push('icon');
    if (++attempts === 1) throw limited(2);
  }, () => true, true);
  await settle();
  const question = delivery.run(1, async () => { calls.push('question'); }, () => true);
  await advance(1999);
  assert.deepEqual(calls, ['icon']);
  await advance(1);
  await question;
  assert.deepEqual(calls, ['icon', 'question']);
  await advance(1000);
  await icon;
  assert.deepEqual(calls, ['icon', 'question', 'icon']);
});

test('default pacing is 3100 milliseconds and a missing retry_after waits five seconds', async t => {
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
  await advance(3099);
  assert.deepEqual(starts, [0]);
  await advance(1);
  assert.deepEqual(starts, [0, 3100]);
  await advance(4999);
  assert.equal(attempts, 1);
  await advance(1);
  assert.equal(await pending, 'sent');
  assert.deepEqual(starts, [0, 3100, 8100]);
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
    const delivery = new TelegramDelivery(1000);
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

test('inactive jobs cancel without API calls or consuming a slot, including after a pacing wait', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
  t.after(() => delivery.close());
  const calls: string[] = [];
  assert.equal(await delivery.run(1, async () => { calls.push('inactive'); }, () => false), undefined);
  await delivery.run(1, async () => { calls.push('initial'); }, () => true);
  let active = true;
  const canceled = delivery.run(1, async () => { calls.push('canceled'); }, () => active);
  const following = delivery.run(1, async () => { calls.push('following'); return 'sent'; }, () => true);
  await settle();
  active = false;
  await advance(1000);
  assert.equal(await canceled, undefined);
  assert.equal(await following, 'sent');
  assert.deepEqual(calls, ['initial', 'following']);
});

test('a question canceled during its 429 cooldown is not retried', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery(1000);
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
  const delivery = new TelegramDelivery(1000);
  t.after(() => delivery.close());
  const calls: string[] = [];
  const retrying = delivery.run(1, async () => { calls.push('limited'); throw limited(60); }, () => true);
  const question = delivery.run(1, async () => { calls.push('question'); }, () => true);
  const icon = delivery.run(1, async () => { calls.push('icon'); }, () => true, true);
  await settle();
  delivery.close();
  delivery.close();
  assert.deepEqual(await Promise.all([retrying, question, icon]), [undefined, undefined, undefined]);
  assert.equal(await delivery.run(2, async () => { calls.push('after-close'); }, () => true), undefined);
  await advance(60000);
  assert.deepEqual(calls, ['limited']);
});

test('close during an in-flight 429 does not requeue or leave its promise unresolved', async t => {
  clock(t);
  const delivery = new TelegramDelivery(1000);
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
