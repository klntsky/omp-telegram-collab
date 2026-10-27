import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Telegraf } from 'telegraf';
import { createBot } from '../src/bot.js';
import { Store } from '../src/store.js';
import type { AppConfig } from '../shared/contracts.js';
import { botId, botToken, ownerUsername } from './telegram-data.js';

test('shutdown while deleting the webhook cannot start an orphan Telegram poller', { timeout: 10_000 }, async () => {
  const events = new EventEmitter();
  let releaseWebhook: () => void = () => assert.fail('webhook request has not arrived');
  let polls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    const method = request.url?.split('/').at(-1);
    response.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: botId, is_bot: true, first_name: 'OMP', username: 'FixtureOmpBot' } }));
    else if (method === 'deleteWebhook') {
      releaseWebhook = () => response.end(JSON.stringify({ ok: true, result: true }));
      events.emit('deleting');
    } else if (method === 'getUpdates') {
      polls++;
      await delay(20);
      response.end(JSON.stringify({ ok: true, result: [] }));
    } else assert.fail(`Unexpected API method ${method}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config: AppConfig = {
    bots: [{ tokenEnv: 'FIXTURE_TOKEN', ownerUsernames: [ownerUsername], miniAppShortName: 'collab' }],
    publicUrl: 'https://example.invalid', host: '127.0.0.1', port: 0, dataDir: '.data',
    omp: { executable: 'omp', cwd: '.', args: [], maxSessions: 1, startupTimeoutMs: 1000 },
  };
  const store = new Store(':memory:');
  const runtime = {
    async ensure(): Promise<never> { throw new Error('No sessions expected in lifecycle check'); },
    async attach(): Promise<never> { throw new Error('No host attachment expected in lifecycle check'); },
    async stop() {}, async close() {},
  };
  const bot = new Telegraf(botToken, { telegram: { apiRoot: `http://127.0.0.1:${address.port}` } });
  const service = createBot({ config, botConfig: config.bots[0]!, token: botToken, store, runtime, bot });
  const deleting = once(events, 'deleting');
  const launch = service.start();
  try {
    await deleting;
    await service.close();
    releaseWebhook();
    await delay(100);
    if (polls > 0) bot.stop('test cleanup');
    await launch;
    assert.equal(polls, 0, 'closing during startup must prevent subsequent getUpdates');
  } finally {
    releaseWebhook();
    await service.close();
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    store.close();
  }
});
