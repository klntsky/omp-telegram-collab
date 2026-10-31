import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Bot, GrammyError, HttpError } from 'grammy';
import { BotService, createBot } from '../src/bot.js';
import { startService } from '../src/cli.js';
import { OmpRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { runAdmin } from '../src/cli-admin.js';
import { botId, botToken, chatId, ownerUsername } from './telegram-data.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';

test('shutdown while deleting the webhook cannot start an orphan Telegram poller', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-poller-lifecycle-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const events = new EventEmitter();
  let releaseWebhook: () => void = () => assert.fail('webhook request has not arrived');
  let polls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    const method = request.url?.split('/').at(-1);
    response.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: botId, is_bot: true, first_name: 'OMP', username: 'FixtureOmpBot' } }));
    else if (method === 'setMyCommands') response.end(JSON.stringify({ ok: true, result: true }));
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
    bots: [{ id: botId, token: botToken, miniAppShortName: 'collab' }],
    instances: {}, configPath: join(directory, 'config.yaml'),
    publicUrl: 'https://example.invalid', host: '127.0.0.1', port: 0, dataDir: directory,
    omp: { executable: 'omp', args: [], maxSessions: 1, startupTimeoutMs: 1000 },
  };
  writeConfig(config);
  const store = new Store(':memory:');
  const runtime = {
    async worktree(): Promise<never> { throw new Error('No worktree creation expected in lifecycle check'); },
    async topicTitleStatus() { return {worktree:false}; },
    async ensure(): Promise<never> { throw new Error('No sessions expected in lifecycle check'); },
    async isRunning() { return false; },
    async resolveExisting() { return undefined; },
    async setSessionTitle(): Promise<never> { throw new Error('No title change expected in lifecycle check'); },
    async attach(): Promise<never> { throw new Error('No host attachment expected in lifecycle check'); },
    async availableModelPresets(_instancePath: string): Promise<string[]> { return ['Fast','Slow']; },
    async modelPresetDetails(): Promise<never> { throw new Error('No model preset details expected in lifecycle check'); },
    async providerUsage(): Promise<never> { throw new Error('No provider usage query expected in lifecycle check'); },
    async listSkills() { return []; },
    async modelPresets(): Promise<never> { throw new Error('No model preset command expected in lifecycle check'); },
    getSessionLimit() { return 5; },
    setSessionLimit() { throw new Error('No session limit change expected in lifecycle check'); },
    increaseSessionLimit() { return false; },
    observeFrame() {},
    markPrompt() {},
    retain() { return () => {}; },
    async stop() { return true; }, async kill() {}, async close() {},
  };
  const bot = new Bot(botToken, { client: { apiRoot: `http://127.0.0.1:${address.port}` } });
  const service = createBot({ config, botConfig: config.bots[0]!, token: botToken, store, runtime, bot });
  const deleting = once(events, 'deleting');
  const launch = service.start();
  try {
    await deleting;
    await service.close();
    releaseWebhook();
    await delay(100);
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

for (const failureKind of ['transport', 429, 503] as const) {
  test(`identity lookup handles explicit rate limits and preserves other failures (${failureKind})`, { timeout: 10_000 }, async () => {
    const app = await createSmokeApp();
    await app.service.close();
    const bot = new Bot(botToken, { client: { apiRoot: app.telegramUrl } });
    const transportFailure = new HttpError('Identity lookup failed', new Error('Original identity transport diagnostic'));
    let lookups = 0;
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getMe' && ++lookups === 1) {
        if (failureKind === 'transport') throw transportFailure;
        return { ok: false, error_code: failureKind, description: 'Identity lookup rejected', parameters: { retry_after: 0 } };
      }
      return previous(method, payload, signal);
    });
    const service = createBot({ config: app.config, botConfig: app.config.bots[0]!, token: botToken, store: app.store, runtime: app.runtime, bot });
    try {
      if (failureKind === 429) {
        await service.initialize();
        assert.equal(lookups, 2);
        assert.equal(bot.botInfo.id, botId);
        return;
      }
      await assert.rejects(service.initialize(), error => {
        if (failureKind === 'transport') assert.equal(error, transportFailure);
        else {
          assert.ok(error instanceof GrammyError);
          assert.equal(error.error_code, failureKind);
          assert.equal(error.description, 'Identity lookup rejected');
        }
        return true;
      });
      assert.equal(lookups, 1);
      assert.equal(bot.isInited(), false);
    } finally { await service.close(); await app.close(); }
  });
}

test('shutdown cancels a pending identity request without starting polling or command publication', { timeout: 10_000 }, async () => {
  const app = await createSmokeApp();
  await app.service.close();
  const entered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const requests: string[] = [];
  let release = () => {};
  const telegram = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    const method = request.url?.split('/').at(-1)!;
    requests.push(method);
    response.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') {
      release = () => response.end(JSON.stringify({ ok: true, result: app.bot.botInfo }));
      response.once('close', disconnected.resolve);
      entered.resolve();
    } else response.end(JSON.stringify({ ok: true, result: true }));
  });
  telegram.listen(0, '127.0.0.1');
  await once(telegram, 'listening');
  const address = telegram.address();
  assert.ok(address && typeof address !== 'string');
  const bot = new Bot(botToken, { client: { apiRoot: `http://127.0.0.1:${address.port}` } });
  const service = createBot({ config: app.config, botConfig: app.config.bots[0]!, token: botToken, store: app.store, runtime: app.runtime, bot });
  const launch = service.start().then(() => ({ error: undefined }), error => ({ error }));
  try {
    await entered.promise;
    await service.close();
    const result = await Promise.race([launch, delay(500).then(() => undefined)]);
    assert.ok(result, 'shutdown must settle startup without waiting for Telegram');
    assert.ok(result.error instanceof HttpError);
    await disconnected.promise;
    assert.deepEqual(requests, ['getMe']);
    assert.equal(bot.isInited(), false);
  } finally {
    release();
    await launch;
    await service.close();
    telegram.closeAllConnections();
    const closed = once(telegram, 'close');
    telegram.close();
    await closed;
    await app.close();
  }
});

async function lifecycleFixture(t: TestContext, options: { startupFailure?: 'getMe' | 'deleteWebhook' | 'getUpdates'; noticeFailure?: boolean; holdOnlineNotice?: boolean; cleanupFailure?: Error } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-telegram-lifecycle-'));
  const secondBotId = botId + 1;
  const groups = [[botId, chatId], [botId, chatId - 1], [secondBotId, chatId - 2]];
  const seed = new Store(join(dir, 'telegram.sqlite'));
  for (const [id, group] of groups) seed.enrollGroup(id!, group!);
  seed.enrollGroup(botId, chatId);
  seed.enrollGroup(secondBotId + 1, chatId - 3);
  const session = seed.createSession({ botId, chatId, threadId: 27, instancePath: dir }, 'Closed session');
  seed.updateSession(session.id, { status: 'closed' });
  seed.close();

  const topics = new Map<string, number>();
  const persistedTopics = new Map<string, number>();
  const setBotStatusTopic = Store.prototype.setBotStatusTopic;
  t.mock.method(Store.prototype, 'setBotStatusTopic', function (this: Store, id: number, group: number, threadId: number) {
    setBotStatusTopic.call(this, id, group, threadId);
    persistedTopics.set(`${id}:${group}`, threadId);
  });
  const notices: { botId: number; payload: Record<string, unknown> }[] = [];
  const ready = new Set<number>();
  const noticeEvents = new EventEmitter();
  let pendingOnline = 0;
  const telegram = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
    const id = Number(request.url?.split('/')[1]?.slice(3).split(':')[0]);
    const method = request.url?.split('/').at(-1);
    response.setHeader('Content-Type', 'application/json');
    if (method === options.startupFailure && id === secondBotId) {
      response.end(JSON.stringify({ ok: false, error_code: method === 'getUpdates' ? 409 : 401, description: 'Fixture startup failure' }));
      return;
    }
    let result: unknown;
    if (method === 'getMe') result = { id, is_bot: true, first_name: 'OMP', username: `Fixture${id}Bot` };
    else if (method === 'createForumTopic') {
      const key = `${id}:${payload.chat_id}`;
      assert.equal(persistedTopics.has(key), false, 'lifecycle notices reuse the persisted status topic');
      const threadId = 100 + topics.size;
      topics.set(key, threadId);
      result = { message_thread_id: threadId, name: 'Bot status', icon_color: 7322096 };
    }
    else if (['deleteWebhook', 'setMyCommands', 'deleteMyCommands', 'pinChatMessage', 'editForumTopic', 'deleteMessage'].includes(method ?? '')) result = true;
    else if (method === 'getForumTopicIconStickers') result = [
      { emoji: '\u26a1', custom_emoji_id: '5312016608254762256' },
      { emoji: '\u2705', custom_emoji_id: '5237699328843200968' },
      { emoji: '\u{1f3c1}', custom_emoji_id: '5408906741125490282' },
    ];
    else if (method === 'getChat') result = { id: Number(payload.chat_id), type: 'supergroup', is_forum: true, title: 'Lifecycle forum' };
    else if (method === 'getChatMember') result = { user: { id: Number(payload.user_id), is_bot: Number(payload.user_id) === id, username: ownerUsername }, status: 'administrator', can_manage_topics: true, can_pin_messages: true };
    else if (method === 'getUpdates') {
      ready.add(id);
      await delay(20);
      result = [];
    } else if (method === 'sendMessage') {
      if (payload.message_thread_id === topics.get(`${id}:${payload.chat_id}`)) {
        notices.push({ botId: id, payload });
        noticeEvents.emit('notice');
        if (options.holdOnlineNotice && notices.filter(notice => notice.botId === id && notice.payload.chat_id === payload.chat_id).length === 1) {
          pendingOnline++;
          response.once('close', () => { pendingOnline--; noticeEvents.emit('online-closed'); });
          return;
        }
        if (options.noticeFailure) {
          response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Fixture cannot send notices' }));
          return;
        }
      }
      result = { message_id: notices.length, date: 0, chat: { id: payload.chat_id, type: 'supergroup' }, text: payload.text };
    } else {
      response.end(JSON.stringify({ ok: false, error_code: 400, description: 'Unexpected fixture method' }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result }));
  });
  telegram.listen(0, '127.0.0.1');
  await once(telegram, 'listening');
  const address = telegram.address();
  assert.ok(address && typeof address !== 'string');
  const initialize = BotService.prototype.initialize;
  const bots: BotService[] = [];
  t.mock.method(BotService.prototype, 'initialize', async function (this: BotService) {
    const token = this.token;
    this.bot.api.config.use(async (_previous, method, payload, signal) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        return await response.json();
      } catch (error) {
        throw new HttpError(`Network request for '${method}' failed!`, error);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    });
    await initialize.call(this);
    bots.push(this);
  });
  let runtimeCloses = 0;
  const closeRuntime = OmpRuntime.prototype.close;
  t.mock.method(OmpRuntime.prototype, 'close', async function (this: OmpRuntime) {
    runtimeCloses++;
    await closeRuntime.call(this);
    if (options.cleanupFailure) throw options.cleanupFailure;
  });
  let storeCloses = 0;
  const closeStore = Store.prototype.close;
  t.mock.method(Store.prototype, 'close', function (this: Store) {
    storeCloses++;
    closeStore.call(this);
  });

  const config: AppConfig = {
    configPath: join(dir, 'config.yaml'),
    bots: [
      { id: botId, token: botToken, miniAppShortName: 'app' },
      { id: secondBotId, token: `${secondBotId}:fixture-other-token-not-valid-on-telegram`, miniAppShortName: 'app' },
    ],
    instances: { [dir]: { chats: groups.map(([botId, chatId]) => ({ botId: botId!, chatId: chatId! })) } },
    publicUrl: 'https://example.invalid', host: '127.0.0.1', port: 0, dataDir: dir,
    omp: { executable: 'omp', args: [], maxSessions: 8, startupTimeoutMs: 1000 },
  };
  writeConfig(config);
  let service: { close(): Promise<void> } | undefined;
  t.after(async () => {
    try {
      await service?.close();
    } finally {
      telegram.closeAllConnections();
      const closed = once(telegram, 'close');
      telegram.close();
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  });
  return {
    notices, ready, groups, config, bots, session,
    get pendingOnline() { return pendingOnline; },
    async waitNotices(count: number) {
      while (notices.length < count) await once(noticeEvents, 'notice');
    },
    async waitOnlineDrained() {
      while (pendingOnline > 0) await once(noticeEvents,'online-closed');
    },
    get runtimeCloses() { return runtimeCloses; },
    get storeCloses() { return storeCloses; },
    async start() { service = await startService(config.configPath); return service; },
  };
}

test('Telegram-only startup polls without binding the Mini App port and shuts down cleanly', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(async () => {
    const closed = Promise.withResolvers<void>();
    occupied.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  fixture.config.port = address.port;
  fixture.config.publicUrl = '';
  for (const bot of fixture.config.bots) delete bot.miniAppShortName;
  writeConfig(fixture.config);
  const service = await fixture.start();
  assert.equal(fixture.ready.size, 2);
  await service.close();
  assert.equal(fixture.runtimeCloses, 1);
  assert.equal(fixture.storeCloses, 1);
});

test('CLI posts online and winding-down notices once per bot and enrolled group in Bot status', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  const service = await fixture.start();
  assert.equal(fixture.ready.size, 2);
  await fixture.waitNotices(3);
  const targets = fixture.groups.map(([id, chat]) => `${id}:${chat}`).sort();
  const assertNotices = (notices: typeof fixture.notices) => {
    assert.deepEqual(notices.map(notice => `${notice.botId}:${notice.payload.chat_id}`).sort(), targets);
    for (const { payload } of notices) {
      assert.deepEqual(Object.keys(payload).sort(), ['chat_id', 'message_thread_id', 'text']);
      assert.equal(typeof payload.message_thread_id, 'number');
      assert.notEqual(payload.message_thread_id, 1, 'lifecycle notices never target General');
    }
  };
  assertNotices(fixture.notices);
  const closing = service.close();
  assert.equal(service.close(), closing, 'duplicate shutdown calls share the same close operation');
  await closing;
  await service.close();
  assert.equal(fixture.notices.length, 6);
  const windingDown = fixture.notices.slice(3);
  assertNotices(windingDown);
  assert.equal(fixture.runtimeCloses, 1);
  assert.equal(fixture.storeCloses, 1);
  await delay(100);
  const restarted = await fixture.start();
  await fixture.waitNotices(9);
  await restarted.close();
});

test('failed lifecycle notifications neither fail startup nor prevent shutdown', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t, { noticeFailure: true });
  const service = await fixture.start();
  await fixture.waitNotices(3);
  assert.equal(fixture.notices.length, 3, 'every enrolled group is attempted despite another notification failing');
  await Promise.all([service.close(), service.close()]);
  assert.equal(fixture.notices.length, 6);
  assert.equal(fixture.runtimeCloses, 1);
  assert.equal(fixture.storeCloses, 1);
});

test('poll readiness does not wait for online delivery and close cancels and drains it', { timeout: 10_000 }, async t => {
  const fixture = await lifecycleFixture(t, { holdOnlineNotice: true });
  const service = await fixture.start();
  assert.equal(fixture.ready.size, 2);
  await fixture.waitNotices(3);
  assert.equal(fixture.pendingOnline, 3);
  await service.close();
  await fixture.waitOnlineDrained();
  const count = fixture.notices.length;
  assert.equal(count, 6, 'shutdown sends its own notices despite cancelled online delivery');
});

test('startup preserves the Telegram failure when cleanup also fails', { timeout: 10_000 }, async t => {
  const fixture = await lifecycleFixture(t, { startupFailure: 'getMe', cleanupFailure: new Error('Fixture cleanup failure') });
  await assert.rejects(fixture.start(), error => {
    assert.ok(error instanceof GrammyError);
    assert.equal(error.error_code, 401);
    return true;
  });
  assert.equal(fixture.runtimeCloses, 1);
  assert.equal(fixture.storeCloses, 1, 'store closes even when runtime cleanup fails');
});

for (const startupFailure of ['getMe', 'deleteWebhook', 'getUpdates'] as const) {
  test(`failed ${startupFailure} startup sends neither online nor winding-down notices`, { timeout: 10_000 }, async t => {
    const fixture = await lifecycleFixture(t, { startupFailure });
    await assert.rejects(fixture.start(), error => {
      assert.ok(error instanceof GrammyError, 'startup must fail at the intended Telegram API request');
      assert.equal(error.error_code, startupFailure === 'getUpdates' ? 409 : 401);
      assert.equal(error.method, startupFailure);
      return true;
    });
    assert.deepEqual(fixture.notices, []);
    assert.equal(fixture.runtimeCloses, 1);
    assert.equal(fixture.storeCloses, 1);
  });
}

test('a readable protected configuration starts normally and preserves writable session state', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  await chmod(fixture.config.configPath, 0o400);
  const source = await readFile(fixture.config.configPath, 'utf8');
  await fixture.start();
  const bot = fixture.bots.find(bot => bot.id === botId)!;
  await bot.authorize(chatId, 42);
  await bot.bot.handleUpdate({ update_id: 99, message: { message_id: 99, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup', title: 'Lifecycle forum', is_forum: true }, from: { id: 42, is_bot: false, first_name: 'Ada', username: ownerUsername }, message_thread_id: 42, forum_topic_created: { name: 'Protected config topic', icon_color: 7322096 } } });
  const stored = new Store(join(fixture.config.dataDir, 'telegram.sqlite'));
  try {
    assert.equal(stored.getTopic({botId,destination:{kind:'topic',chatId,threadId:42}})?.instancePath, fixture.config.dataDir);
    assert.equal(stored.getSession(fixture.session.id)?.id, fixture.session.id);
  } finally { stored.close(); }
  await assert.rejects(runAdmin(['configure', '--max-sessions', '50'], fixture.config.configPath), /read-only/);
  assert.equal(await readFile(fixture.config.configPath, 'utf8'), source);
});

test('CLI chat removal is acknowledged live and revokes routing without deleting saved topics', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  await fixture.start();
  const bot = fixture.bots.find(bot => bot.id === botId)!;
  await bot.authorize(chatId, 42);
  await runAdmin(['chat', 'remove', fixture.config.dataDir, '--chat', String(chatId), '--bot', String(botId)], fixture.config.configPath);
  await assert.rejects(bot.authorize(chatId, 42), /assignment/);
  const stored = new Store(join(fixture.config.dataDir, 'telegram.sqlite'));
  try {
    assert.equal(stored.getSession(fixture.session.id)?.instancePath, fixture.config.dataDir);
    assert.equal(stored.getSession(fixture.session.id)?.status, 'closed');
  } finally { stored.close(); }
});

async function sessionControl(config: AppConfig, payload: Record<string, unknown>, path = '/session/join') {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Record<string, unknown> }>();
  const request = httpRequest({ socketPath: join(config.dataDir, 'control.sock'), path, method: 'POST' }, response => {
    let body = '';
    response.on('data', chunk => {
      body += chunk;
      if (response.headers['content-type'] === 'application/x-ndjson' && body.includes('\n')) {
        resolve({ status: response.statusCode!, body: JSON.parse(body.slice(0, body.indexOf('\n'))) });
        request.destroy();
      }
    });
    response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
    response.on('error', reject);
  });
  request.on('error', reject);
  request.end(JSON.stringify({ configPath: config.configPath, ...payload }));
  return promise;
}

for (const publicUrl of ['', 'https://example.invalid']) {
  test(`private session join resolves a guarded binding independently of publicUrl (${publicUrl || 'disabled'})`, { timeout: 30_000 }, async t => {
    const fixture = await lifecycleFixture(t);
    t.mock.method(BotService.prototype, 'ensureMirroring', async () => {});
    fixture.config.publicUrl = publicUrl;
    if (publicUrl) {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      assert.ok(address && typeof address !== 'string');
      fixture.config.port = address.port;
      const closed = once(reservation, 'close');
      reservation.close();
      await closed;
    }
    writeConfig(fixture.config);
    await fixture.start();
    const store = new Store(join(fixture.config.dataDir, 'telegram.sqlite'));
    t.after(() => store.close());
    store.updateSession(fixture.session.id, { status: 'open' });
    let ensured = 0;
    t.mock.method(OmpRuntime.prototype, 'ensure', async (session: TopicSession, guard?: () => Promise<void>) => {
      assert.equal(session.id, fixture.session.id);
      assert.equal(typeof guard, 'function');
      await guard!();
      ensured++;
      return { instanceId: 'fixture-host', sessionId: 'fixture-session', generation: 1, url: 'https://relay.invalid/join#private-session-secret' };
    });
    const result = await sessionControl(fixture.config, { chatId, topicId: 27 });
    assert.deepEqual(result, { status: 200, body: { url: 'https://relay.invalid/join#private-session-secret', executable: 'omp' } });
    assert.equal(ensured, 1);
    assert.equal((await stat(join(fixture.config.dataDir, 'control.sock'))).mode & 0o777, 0o600);
    if (publicUrl) {
      const exposed = await fetch(`http://127.0.0.1:${fixture.config.port}/session/join`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configPath: fixture.config.configPath, chatId, topicId: 27 }),
      });
      assert.notEqual(exposed.status, 200);
      assert.equal((await exposed.text()).includes('private-session-secret'), false);
    }
    assert.deepEqual(await sessionControl(fixture.config, {}, '/reload'), { status: 200, body: { ok: true } });
    for (const payload of [{ chatId: 1, topicId: 27 }, { chatId, topicId: 1 }, { chatId, topicId: 2.5 }, { chatId, topicId: 999 }]) {
      assert.equal((await sessionControl(fixture.config, payload)).status, 409);
    }
    for (const status of ['closed', 'detached'] as const) {
      store.updateSession(fixture.session.id, { status });
      assert.equal((await sessionControl(fixture.config, { chatId, topicId: 27 })).status, 409);
    }
    assert.equal(ensured, 1, 'invalid and unavailable sessions never reach runtime ensure');
  });
}

test('private session join preserves runtime diagnostics and rejects a detach during host admission', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  t.mock.method(BotService.prototype, 'ensureMirroring', async () => {});
  await fixture.start();
  await fixture.waitNotices(fixture.groups.length);
  const store = new Store(join(fixture.config.dataDir, 'telegram.sqlite'));
  t.after(() => store.close());
  store.updateSession(fixture.session.id, { status: 'open' });
  t.mock.method(OmpRuntime.prototype, 'ensure', async () => {
    throw Object.assign(new Error('Original host launch diagnostic'), { code: 'ENOENT', signal: 'SIGTERM' });
  });
  assert.deepEqual(await sessionControl(fixture.config, { chatId, topicId: 27 }), {
    status: 409, body: { error: 'Original host launch diagnostic', code: 'ENOENT', signal: 'SIGTERM' },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(OmpRuntime.prototype, 'ensure', async (_session: TopicSession, guard?: () => Promise<void>) => {
    entered.resolve();
    await release.promise;
    await guard!();
    assert.fail('detached session must not create a host');
  });
  const joining = sessionControl(fixture.config, { chatId, topicId: 27 });
  await entered.promise;
  store.updateSession(fixture.session.id, { status: 'detached' });
  release.resolve();
  const rejected = await joining;
  assert.equal(rejected.status, 409);
  assert.match(String(rejected.body.error), /not open or changed/);
  assert.equal('url' in rejected.body, false);
});

test('private session join rejects ambiguous bot ownership, unassignment, and termination', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  t.mock.method(BotService.prototype, 'ensureMirroring', async () => {});
  const secondBot = fixture.config.bots[1]!;
  fixture.config.instances[fixture.config.dataDir]!.chats.push({ botId: secondBot.id, chatId });
  writeConfig(fixture.config);
  const store = new Store(join(fixture.config.dataDir, 'telegram.sqlite'));
  t.after(() => store.close());
  store.enrollGroup(secondBot.id, chatId);
  const duplicate = store.createSession({ botId: secondBot.id, chatId, threadId: 27, instancePath: fixture.config.dataDir }, 'Other bot session');
  store.updateSession(duplicate.id, { status: 'closed' });
  await fixture.start();
  await fixture.waitNotices(fixture.groups.length);
  let ensured = 0;
  t.mock.method(OmpRuntime.prototype, 'ensure', async () => {
    ensured++;
    assert.fail('rejected sessions must not reach host admission');
  });
  const ambiguous = await sessionControl(fixture.config, { chatId, topicId: 27 });
  assert.equal(ambiguous.status, 409);
  assert.match(String(ambiguous.body.error), /ambiguous/);
  fixture.config.instances[fixture.config.dataDir]!.chats =
    fixture.config.instances[fixture.config.dataDir]!.chats.filter(chat => chat.chatId !== chatId);
  writeConfig(fixture.config);
  const unassigned = await sessionControl(fixture.config, { chatId, topicId: 27 });
  assert.equal(unassigned.status, 409);
  assert.match(String(unassigned.body.error), /No enrolled, assigned/);
  fixture.config.instances[fixture.config.dataDir]!.chats.push({ botId, chatId });
  fixture.config.terminated = true;
  writeConfig(fixture.config);
  const terminated = await sessionControl(fixture.config, { chatId, topicId: 27 });
  assert.equal(terminated.status, 409);
  assert.match(String(terminated.body.error), /terminated/);
  assert.equal(ensured, 0);
});

for (const disconnect of ['client close', 'generation replacement'] as const) {
test(`private session join retains its host until ${disconnect}`, { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  t.mock.method(BotService.prototype, 'ensureMirroring', async () => {});
  await fixture.start();
  const store = new Store(join(fixture.config.dataDir, 'telegram.sqlite'));
  t.after(() => store.close());
  store.updateSession(fixture.session.id, { status: 'open' });
  let leases = 0;
  const released = Promise.withResolvers<void>();
  t.mock.method(OmpRuntime.prototype, 'retain', (id: string) => {
    assert.equal(id, fixture.session.id);
    leases++;
    return () => { leases--; released.resolve(); };
  });
  t.mock.method(OmpRuntime.prototype, 'ensure', async (_session: TopicSession, guard?: () => Promise<void>) => {
    await guard!();
    return { instanceId: 'fixture', sessionId: 'fixture', generation: 1, url: 'https://relay.invalid/#private' };
  });
  const ready = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const request = httpRequest({
    socketPath: join(fixture.config.dataDir, 'control.sock'), path: '/session/join', method: 'POST',
  }, response => {
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/x-ndjson');
    response.once('data', chunk => {
      assert.equal(JSON.parse(String(chunk).trim()).url, 'https://relay.invalid/#private');
      ready.resolve();
    });
    response.on('error', ready.reject);
    response.once('close', disconnected.resolve);
  });
  request.on('error', ready.reject);
  t.after(() => request.destroy());
  request.end(JSON.stringify({ configPath: fixture.config.configPath, chatId, topicId: 27 }));
  await ready.promise;
  assert.equal(leases, 1);
  await delay(20);
  assert.equal(leases, 1, 'writing the binding does not release the foreground host');
  if (disconnect === 'client close') request.destroy();
  else {
    store.updateSession(fixture.session.id, { status: 'closed' });
    fixture.config.publicUrl = '';
    writeConfig(fixture.config);
    assert.deepEqual(await sessionControl(fixture.config, {}, '/reload'), { status: 200, body: { ok: true } });
  }
  await disconnected.promise;
  await released.promise;
  assert.equal(leases, 0);
});
}
