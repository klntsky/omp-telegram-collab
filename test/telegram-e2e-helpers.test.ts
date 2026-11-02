import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { Api } from 'grammy';
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
