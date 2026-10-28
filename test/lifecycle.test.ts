import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Telegraf, TelegramError } from 'telegraf';
import { BotService, createBot } from '../src/bot.js';
import { startService } from '../src/cli.js';
import { OmpRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { AppConfig } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { runAdmin } from '../src/cli-admin.js';
import { botId, botToken, chatId, ownerUsername } from './telegram-data.js';

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
    async ensure(): Promise<never> { throw new Error('No sessions expected in lifecycle check'); },
    async isRunning() { return false; },
    async attach(): Promise<never> { throw new Error('No host attachment expected in lifecycle check'); },
    async availableModelPresets(_instancePath: string): Promise<string[]> { return ['Fast','Slow']; },
    async modelPresets(): Promise<never> { throw new Error('No model preset command expected in lifecycle check'); },
    getSessionLimit() { return 5; },
    increaseSessionLimit() { return false; },
    observeFrame() {},
    markPrompt() {},
    retain() { return () => {}; },
    async stop() {}, async kill() {}, async close() {},
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

async function lifecycleFixture(t: TestContext, options: { startupFailure?: 'getMe' | 'deleteWebhook' | 'getUpdates'; noticeFailure?: boolean } = {}) {
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

  const notices: { botId: number; payload: Record<string, unknown> }[] = [];
  const ready = new Set<number>();
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
      notices.push({ botId: id, payload });
      if (options.noticeFailure) {
        response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Fixture cannot send notices' }));
        return;
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
    this.bot.telegram.options.apiRoot = `http://127.0.0.1:${address.port}`;
    delete this.bot.telegram.options.agent;
    await initialize.call(this);
    bots.push(this);
  });
  let runtimeCloses = 0;
  const closeRuntime = OmpRuntime.prototype.close;
  t.mock.method(OmpRuntime.prototype, 'close', async function (this: OmpRuntime) {
    runtimeCloses++;
    await closeRuntime.call(this);
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
    instances: { [dir]: { admins: [ownerUsername], chats: groups.map(([botId, chatId]) => ({ botId: botId!, chatId: chatId! })) } },
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
    get runtimeCloses() { return runtimeCloses; },
    get storeCloses() { return storeCloses; },
    async start() { service = await startService(config.configPath); return service; },
  };
}

test('CLI posts online and winding-down notices once per bot and enrolled group in General', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t);
  const service = await fixture.start();
  assert.equal(fixture.ready.size, 2);
  const targets = fixture.groups.map(([id, chat]) => `${id}:${chat}`).sort();
  const assertNotices = (notices: typeof fixture.notices, text: unknown) => {
    assert.equal(typeof text, 'string');
    assert.deepEqual(notices.map(notice => `${notice.botId}:${notice.payload.chat_id}`).sort(), targets);
    for (const { payload } of notices) {
      assert.deepEqual(Object.keys(payload).sort(), ['chat_id', 'text'], 'General is targeted without message_thread_id=1 or a session reply target');
      assert.equal(payload.text, text);
    }
  };
  const onlineText = fixture.notices[0]?.payload.text;
  assert.match(String(onlineText), /^OMP bot service is back online \(restarting took \d+\.\d{2} seconds\)\.$/);
  assertNotices(fixture.notices, onlineText);
  const closing = service.close();
  assert.equal(service.close(), closing, 'duplicate shutdown calls share the same close operation');
  await closing;
  await service.close();
  assert.equal(fixture.notices.length, 6);
  const windingDown = fixture.notices.slice(3);
  const windingDownText = windingDown[0]?.payload.text;
  assert.notEqual(windingDownText, onlineText, 'shutdown sends a distinct lifecycle notification');
  assertNotices(windingDown, windingDownText);
  assert.equal(fixture.runtimeCloses, 1);
  assert.equal(fixture.storeCloses, 1);
  await delay(100);
  const restarted = await fixture.start();
  const resumedText = String(fixture.notices[6]?.payload.text);
  const elapsed = /restarting took (\d+\.\d{2}) seconds/.exec(resumedText);
  assert.ok(elapsed, resumedText);
  assert.ok(Number(elapsed[1]) >= 0.1, 'restart timing includes the gap between service generations');
  await restarted.close();
});

test('failed lifecycle notifications neither fail startup nor prevent shutdown', { timeout: 30_000 }, async t => {
  const fixture = await lifecycleFixture(t, { noticeFailure: true });
  const service = await fixture.start();
  assert.equal(fixture.notices.length, 3, 'every enrolled group is attempted despite another notification failing');
  await Promise.all([service.close(), service.close()]);
  assert.equal(fixture.notices.length, 6);
  assert.equal(fixture.runtimeCloses, 1);
  assert.equal(fixture.storeCloses, 1);
});

for (const startupFailure of ['getMe', 'deleteWebhook', 'getUpdates'] as const) {
  test(`failed ${startupFailure} startup sends neither online nor winding-down notices`, { timeout: 10_000 }, async t => {
    const fixture = await lifecycleFixture(t, { startupFailure });
    await assert.rejects(fixture.start(), error => {
      assert.ok(error instanceof TelegramError, 'startup must fail at the intended Telegram API request');
      assert.equal(error.code, startupFailure === 'getUpdates' ? 409 : 401);
      assert.ok('method' in error.on);
      assert.equal(error.on.method, startupFailure);
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
    assert.equal(stored.getTopic({ botId, chatId, threadId: 42 })?.instancePath, fixture.config.dataDir);
    assert.equal(stored.getSession(fixture.session.id)?.id, fixture.session.id);
  } finally { stored.close(); }
  await assert.rejects(runAdmin(['admin', 'add', fixture.config.dataDir, 'DeniedAdmin'], fixture.config.configPath), /read-only/);
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
