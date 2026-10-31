import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setImmediate as settle } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { Bot, GrammyError, HttpError } from 'grammy';
import { TelegramDelivery } from '../src/telegram-delivery.js';
import { installTelegramRetry } from '../src/telegram-retry.js';

type Transformer = Parameters<Bot['api']['config']['use']>[0];

function fixture(t: TestContext, transport: (...args: Parameters<Transformer>) => Promise<unknown>) {
  const shutdown = new AbortController();
  const bot = new Bot('123456:test-token');
  bot.api.config.use(transport as Transformer);
  installTelegramRetry(bot, shutdown.signal);
  t.after(() => shutdown.abort());
  return { bot, shutdown };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  return async (ms: number) => {
    t.mock.timers.tick(ms);
    await settle();
  };
}

function limited(retry_after: number) {
  return { ok: false as const, error_code: 429, description: 'Too Many Requests', parameters: { retry_after } };
}

const message = {
  message_id: 81,
  date: 1,
  chat: { id: -100123, type: 'supergroup' as const, title: 'Fixture' },
  text: 'payload',
};

test('HTTP Telegram responses retry a nonzero explicit cooldown before delivering the original payload', { timeout: 5000 }, async t => {
  const requests: { path: string | undefined; payload: unknown; at: number }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url,
      payload: JSON.parse(Buffer.concat(chunks).toString()),
      at: performance.now(),
    });
    response.writeHead(requests.length === 1 ? 429 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests.length === 1 ? limited(0.05) : { ok: true, result: message }));
  });
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const bot = new Bot('123456:test-token', { client: { apiRoot: `http://127.0.0.1:${address.port}` } });
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  installTelegramRetry(bot, shutdown.signal);
  const delivered = await bot.api.sendMessage(-100123, 'payload', { message_thread_id: 42 });
  assert.deepEqual(delivered, message);
  const expected = {
    path: '/bot123456:test-token/sendMessage',
    payload: { chat_id: -100123, text: 'payload', message_thread_id: 42 },
  };
  assert.deepEqual(requests.map(({ path, payload }) => ({ path, payload })), [expected, expected]);
  assert.ok(requests[1]!.at - requests[0]!.at >= 40);
});

test('direct sendMessage retries repeated explicit 429 responses without changing the request', async t => {
  const advance = clock(t);
  const attempts: { method: string; payload: unknown; at: number }[] = [];
  const { bot } = fixture(t, async (_previous, method, payload) => {
    attempts.push({ method, payload: structuredClone(payload), at: Date.now() });
    if (attempts.length === 1) return limited(2);
    if (attempts.length === 2) return limited(1);
    return { ok: true, result: message };
  });
  const options = {
    message_thread_id: 42,
    disable_notification: true,
    reply_parameters: { message_id: 17, allow_sending_without_reply: true },
    entities: [{ type: 'bold' as const, offset: 0, length: 7 }],
  };
  const expectedPayload = { chat_id: -100123, text: 'payload', ...options };
  let userOperations = 0;
  const send = () => {
    userOperations++;
    return bot.api.sendMessage(-100123, 'payload', options);
  };
  const pending = send();
  await settle();
  assert.deepEqual(attempts, [{ method: 'sendMessage', payload: expectedPayload, at: 0 }]);
  await advance(1999);
  assert.equal(attempts.length, 1);
  await advance(1);
  assert.deepEqual(attempts[1], { method: 'sendMessage', payload: expectedPayload, at: 2000 });
  await advance(999);
  assert.equal(attempts.length, 2);
  await advance(1);
  assert.strictEqual(await pending, message);
  assert.deepEqual(attempts[2], { method: 'sendMessage', payload: expectedPayload, at: 3000 });
  assert.equal(userOperations, 1);
});

test('retry handling also covers non-message API methods and a zero retry_after', async t => {
  const advance = clock(t);
  const calls: { method: string; payload: unknown }[] = [];
  const commands = [{ command: 'start', description: 'Start' }];
  const { bot } = fixture(t, async (_previous, method, payload) => {
    calls.push({ method, payload: structuredClone(payload) });
    return calls.length === 1 ? limited(0) : { ok: true, result: true };
  });
  const pending = bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } });
  await settle();
  await advance(0);
  assert.equal(await pending, true);
  assert.deepEqual(calls, [
    { method: 'setMyCommands', payload: { commands, scope: { type: 'all_private_chats' } } },
    { method: 'setMyCommands', payload: { commands, scope: { type: 'all_private_chats' } } },
  ]);
});

for (const error_code of [400, 403, 500]) {
  test(`a permanent raw Telegram ${error_code} response retains its protocol details without retry`, async t => {
    const advance = clock(t);
    const response = {
      ok: false as const,
      error_code,
      description: 'Original Telegram diagnostic\nAdditional diagnostic',
      parameters: { migrate_to_chat_id: -100987, retry_after: 1 },
    };
    let attempts = 0;
    const { bot } = fixture(t, async () => { attempts++; return response; });
    await assert.rejects(bot.api.sendMessage(-100123, 'payload', { message_thread_id: 42 }), error => {
      assert.ok(error instanceof GrammyError);
      assert.equal(error.error_code, response.error_code);
      assert.equal(error.description, response.description);
      assert.deepEqual(error.parameters, response.parameters);
      assert.equal(error.method, 'sendMessage');
      assert.deepEqual(error.payload, { chat_id: -100123, text: 'payload', message_thread_id: 42 });
      return true;
    });
    await advance(10000);
    assert.equal(attempts, 1);
  });
}

for (const kind of ['telegram', 'transport', 'lookalike'] as const) {
  test(`a thrown ${kind} exception is propagated by identity without replay`, async t => {
    const advance = clock(t);
    const cause = new Error('ECONNRESET after request transmission');
    const failure = kind === 'telegram'
      ? new GrammyError('Original diagnostic', limited(1), 'sendMessage', { chat_id: -100123, text: 'payload' })
      : kind === 'transport'
        ? new HttpError('Original transport diagnostic', cause)
        : Object.assign(new Error('Not a Telegram response'), { error_code: 429, parameters: { retry_after: 1 } });
    let attempts = 0;
    const { bot } = fixture(t, async () => { attempts++; throw failure; });
    await assert.rejects(bot.api.sendMessage(-100123, 'payload'), error => error === failure);
    await advance(10000);
    assert.equal(attempts, 1);
  });
}

for (const retryAfter of [undefined, -1, NaN, Infinity]) {
  test(`a raw 429 with invalid retry_after ${String(retryAfter)} is not replayed`, async t => {
    const advance = clock(t);
    let attempts = 0;
    const response = {
      ok: false as const,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: retryAfter === undefined ? undefined : { retry_after: retryAfter },
    };
    const { bot } = fixture(t, async () => { attempts++; return response; });
    await assert.rejects(bot.api.sendMessage(-100123, 'payload'), error => {
      assert.ok(error instanceof GrammyError);
      assert.equal(error.error_code, 429);
      assert.deepEqual(error.parameters, response.parameters ?? {});
      return true;
    });
    await advance(10000);
    assert.equal(attempts, 1);
  });
}

for (const boundary of ['request', 'service'] as const) {
  test(`${boundary} cancellation interrupts the retry delay without another API attempt`, async t => {
    const advance = clock(t);
    const request = new TelegramAbortController();
    let attempts = 0;
    const { bot, shutdown } = fixture(t, async () => { attempts++; return limited(60); });
    const pending = bot.api.sendMessage(-100123, 'payload', {}, request.signal);
    const rejected = assert.rejects(pending);
    await settle();
    assert.equal(attempts, 1);
    await advance(1000);
    (boundary === 'request' ? request : shutdown).abort();
    await settle();
    await rejected;
    await advance(120000);
    assert.equal(attempts, 1);
  });
}

test('delivery retains its relevance check instead of retrying stale work inside the API boundary', async t => {
  const advance = clock(t);
  const delivery = new TelegramDelivery();
  t.after(() => delivery.close());
  const calls: unknown[] = [];
  const { bot } = fixture(t, async (_previous, _method, payload) => {
    calls.push(structuredClone(payload));
    return calls.length === 1 ? limited(2) : { ok: true, result: message };
  });
  let relevant = true;
  const pending = delivery.run(-100123, () => bot.api.sendMessage(-100123, 'stale'), () => relevant);
  await settle();
  relevant = false;
  await advance(2000);
  assert.equal(await pending, undefined);
  assert.deepEqual(calls, [{ chat_id: -100123, text: 'stale' }]);
  assert.strictEqual(await bot.api.sendMessage(-100123, 'current'), message);
  assert.deepEqual(calls, [
    { chat_id: -100123, text: 'stale' },
    { chat_id: -100123, text: 'current' },
  ]);
});
