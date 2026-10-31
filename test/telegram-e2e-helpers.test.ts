import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Api } from 'grammy';
import { TelegramClient } from '@mtcute/node';
import { TelegramTestUser } from './e2e/helpers/telegram-user.js';
import { TelegramTestInbox } from './e2e/helpers/telegram-updates.js';

test('Telegram inbox retains unmatched updates and acknowledges each fetched batch', { timeout: 10000 }, async t => {
  const offsets: number[] = [];
  const batches = [
    [{ update_id: 10 }, { update_id: 11 }],
    [{ update_id: 12 }],
  ];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    offsets.push(JSON.parse(body).offset);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: batches.shift() ?? [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close(error => error ? reject(error) : resolve());
    await promise;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const api = new Api('123:fixture', { apiRoot: `http://127.0.0.1:${address.port}`, environment: 'test' });
  const controller = new AbortController();
  const inbox = new TelegramTestInbox(api, controller.signal);
  assert.equal((await inbox.waitFor(update => update.update_id === 11)).update_id, 11);
  assert.equal((await inbox.waitFor(update => update.update_id === 10)).update_id, 10);
  assert.equal((await inbox.waitFor(update => update.update_id === 12)).update_id, 12);
  assert.deepEqual(offsets, [0, 12]);
  const reason = new Error('test cancellation');
  controller.abort(reason);
  await assert.rejects(inbox.waitFor(() => true), error => error === reason);
});

test('failed Telegram login waits for client destruction and preserves the RPC error', { timeout: 10000 }, async t => {
  const failure = new Error('original RPC failure');
  const destroying = Promise.withResolvers<void>();
  const destroyed = Promise.withResolvers<void>();
  let closing = false;
  t.mock.method(TelegramClient.prototype, 'call', async () => { throw failure; });
  t.mock.method(TelegramClient.prototype, 'destroy', () => {
    if (closing) return Promise.resolve();
    closing = true;
    destroying.resolve();
    return destroyed.promise;
  });
  t.after(() => destroyed.resolve());
  let settled = false;
  const login = TelegramTestUser.login({ apiId: 123, apiHash: 'fixture', phone: '9996621234' });
  const rejected = assert.rejects(login, error => error === failure);
  void login.then(() => { settled = true; }, () => { settled = true; });
  await destroying.promise;
  await setImmediate();
  assert.equal(settled, false);
  destroyed.resolve();
  await rejected;
});
