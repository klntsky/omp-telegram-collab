import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Telegraf, type Context } from 'telegraf';
import WebSocket from 'ws';
import type { HostFrame, GuestFrame, AssistantMessage, SessionEntry } from '@oh-my-pi/pi-wire';
import type { AppConfig, CollabHandlers } from '../shared/contracts.js';
import { createBot } from '../src/bot.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { botToken, botId, chatId, ownerId, ownerUsername, signedInitData } from '../test/telegram-data.js';

async function listen(server: Server, port = 0): Promise<string> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
  await promise;
}
export async function createSmokeApp(options: { competingStartAfterRejection?: boolean; pollingTransientFailure?: boolean } = {}) {
  const messages: Record<string, unknown>[] = [];
  const accepted: GuestFrame[] = [];
  const events = new EventEmitter();
  const connections = new Set<CollabHandlers>();
  let member = true;
  let memberStatus: 'administrator' | 'creator' | 'member' = 'administrator';
  let thread = 20;
  let messageId = 100;
  let updateId = 0;
  let rejectionCount = 1;
  let transientFailures = options.pollingTransientFailure ? 1 : 0;
  let connectionCount = 0;
  const user: NonNullable<Context['from']> = { id: ownerId, first_name: 'Ada', username: ownerUsername, is_bot: false };
  let currentUser = user;
  const me = { id: botId, first_name: 'OMP', username: 'FixtureOmpBot', is_bot: true, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  const group = { id: chatId, type: 'supergroup' as const, title: 'Fixture project', is_forum: true };
  const telegram = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = body ? JSON.parse(body) : {};
    const method = request.url?.split('/').at(-1);
    let result: unknown;
    if (method === 'getMe') result = me;
    else if (method === 'getChat') result = group;
    else if (method === 'getChatMember') result = Number(params.user_id) === botId
      ? { user: me, status: 'administrator', can_manage_topics: true }
      : { user: { ...currentUser, id: Number(params.user_id) }, status: member ? memberStatus : 'left' };
    else if (method === 'deleteWebhook') result = true;
    else if (method === 'getUpdates') {
      if (transientFailures-- > 0) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: false, error_code: 429, description: 'Fixture rate limit', parameters: { retry_after: 0 } }));
        return;
      }
      events.emit('poll');
      await delay(20);
      result = [];
    }
    else if (method === 'createForumTopic') result = { message_thread_id: ++thread, name: params.name, icon_color: 7322096 };
    else if (method === 'sendMessage') {
      messages.push(params);
      result = { ...params, message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: group, from: me };
      events.emit('message');
    } else if (method === 'answerCallbackQuery') result = true;
    else throw new Error(`Unexpected fixture Telegram method ${method}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, result }));
  });
  const telegramUrl = await listen(telegram);
  const store = new Store(':memory:');
  const config: AppConfig = {
    bots: [{ tokenEnv: 'FIXTURE_TOKEN', ownerUsernames: [ownerUsername], miniAppShortName: 'collab' }],
    publicUrl: 'http://127.0.0.1', host: '127.0.0.1', port: 0, dataDir: '.data',
    omp: { executable: 'omp', cwd: process.cwd(), args: [], maxSessions: 5, startupTimeoutMs: 60000 },
  };
  const runtime = {
    async ensure(session: { id: string }) { return { instanceId: session.id, sessionId: session.id, generation: 1, url: 'server-only-secret-capability' }; },
    async attach(instanceId: string) { return { instanceId, sessionId: 'attached-conversation', generation: 1, url: 'server-only-secret-capability' }; },
    async stop() {}, async close() {},
  };
  const state = { cwd: '/fixture/project', isStreaming: false, queuedMessageCount: 0, sessionName: 'Telegram fixture session', participants: [{ name: 'Local host', role: 'host' as const }] };
  const assistant: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: '## Session fixture\n\nThe source-owned Collab renderer is connected through the authenticated gateway.\n\n```ts\nconst topic = { threadId: 21 };\n```' }],
    timestamp: Date.now(), model: 'fixture-no-model-call', stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  };
  assistant.content.push({ type: 'toolCall', id: 'read-fixture', name: 'read', arguments: { path: 'src/auth.ts' }, intent: 'Inspecting the authentication boundary' });
  const entries: SessionEntry[] = [
    { type: 'message', id: 'user-fixture', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Verify the Telegram session renderer.', timestamp: Date.now() } },
    { type: 'message', id: 'assistant-fixture', parentId: 'user-fixture', timestamp: new Date().toISOString(), message: assistant },
    { type: 'message', id: 'tool-fixture', parentId: 'assistant-fixture', timestamp: new Date().toISOString(), message: { role: 'toolResult', toolCallId: 'read-fixture', toolName: 'read', content: [{ type: 'text', text: 'export type SessionAccess = \"member\" | \"denied\";' }], timestamp: Date.now(), isError: false } },
  ];
  const connect = async (binding: { sessionId: string }, _name: string, handlers: CollabHandlers) => {
    connectionCount++;
    connections.add(handlers);
    handlers.onFrame({ t: 'welcome', proto: 3, header: { type: 'session', id: binding.sessionId, title: 'Telegram fixture session', cwd: state.cwd, timestamp: new Date().toISOString() }, state, agents: [], entryCount: entries.length });
    handlers.onFrame({ t: 'snapshot-chunk', entries, final: true });
    return {
      send(frame: GuestFrame) {
        if (frame.t === 'prompt' && rejectionCount-- > 0) {
          queueMicrotask(() => {
            handlers.onFrame({ t: 'error', message: 'prompting is unavailable until the host finishes starting up' });
            if (options.competingStartAfterRejection) handlers.onFrame({ t: 'event', event: { type: 'agent_start' } });
          });
          return;
        }
        accepted.push(frame);
        if (frame.t === 'prompt') {
          handlers.onFrame({ t: 'entry', entry: { type: 'custom_message', customType: 'collab-prompt', content: frame.text, details: { from: _name }, display: true, id: `accepted-${accepted.length}`, parentId: null, timestamp: new Date().toISOString() } });
          handlers.onFrame({ t: 'event', event: { type: 'agent_start' } });
          handlers.onFrame({ t: 'event', event: { type: 'agent_end' } });
        }
        events.emit('accepted');
      },
      close() { connections.delete(handlers); },
    };
  };
  const bot = new Telegraf(botToken, { telegram: { apiRoot: telegramUrl } });
  const service = createBot({ config, botConfig: config.bots[0]!, token: botToken, store, runtime, connect, bot });
  await service.initialize();
  const reservation = createHttpServer();
  const reservedUrl = await listen(reservation);
  const port = Number(new URL(reservedUrl).port);
  await close(reservation);
  config.publicUrl = reservedUrl;
  const server = createServer({ config, bots: [service], store, runtime, connect });
  const url = await listen(server, port);
  async function update(message: Record<string, unknown>, from = user) {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: group, from, ...message } } as Parameters<typeof bot.handleUpdate>[0]);
  }
  return {
    url, store, config, bot, service, messages, accepted, events, update,
    setMember(value: boolean) { member = value; },
    setCurrentMember(value: { username?: string; is_bot?: boolean; status?: 'administrator' | 'creator' | 'member' }) {
      currentUser = { ...user, username: value.username, is_bot: value.is_bot ?? false };
      memberStatus = value.status ?? 'administrator';
    },
    get connectionCount() { return connectionCount; },
    rejectNextPrompt() { rejectionCount = 1; },
    disconnect() { for (const connection of [...connections]) connection.onClose('Fixture relay disconnected'); },
    emit(frame: HostFrame) { for (const connection of connections) connection.onFrame(frame); },
    appendEntry(entry: SessionEntry) { entries.push(entry); },
    initData(sessionId: string) { return signedInitData(sessionId); },
    async close() { await server.closeConnections(); await close(server); await service.close(); store.close(); await close(telegram); },
  };
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

export async function verifyTelegramFlow() {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/new unauthorized' });
    assert.equal(app.store.listSessions(botId).length, 0, 'unenrolled groups cannot launch OMP');
    await app.update({ text: '/setup' });
    assert.equal(app.store.isEnrolled(botId, chatId), true);
    await app.update({ text: '/new Implement login' });
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(session.threadId, 21);
    await waitUntil(() => app.accepted.some(frame => frame.t === 'prompt'), 'initial task was not delivered after explicit startup rejection');
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Implement login' }]);
    const button = app.messages.find(value => JSON.stringify(value.reply_markup).includes('startapp='));
    assert.ok(button);
    assert.ok(JSON.stringify(button).includes(`startapp=s_${session.id}`));
    assert.ok(!JSON.stringify(button).includes('web_app'));
    await app.update({ message_thread_id: 21, text: 'Ordinary team discussion.' });
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 1);
    await app.update({ message_thread_id: 21, text: '@FixtureOmpBot Check redirect', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    app.rejectNextPrompt();
    const rejected = once(app.events, 'message');
    await app.update({ message_thread_id: 21, text: '@FixtureOmpBot Try during startup', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    await rejected;
    console.log('Observed prompt rejection notification:', app.messages.at(-1)?.text);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    await app.update({ message_thread_id: 21, forum_topic_created: { name: 'Duplicate service event', icon_color: 7322096 } });
    assert.equal(app.store.listSessions(botId).length, 1);
    await app.update({ message_thread_id: 21, forum_topic_closed: {} });
    await app.update({ message_thread_id: 21, text: '@FixtureOmpBot Do not run', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    await app.update({ message_thread_id: 21, forum_topic_reopened: {} });
    const beforeReply = app.messages.length;
    const replyText = 'Agent result ' + 'x'.repeat(5000);
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: replyText }], model: 'fixture-no-model-call', stopReason: 'stop', timestamp: Date.now() + 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
    app.emit({ t: 'event', event: { type: 'message_end', message: reply } });
    app.emit({ t: 'entry', entry: { type: 'message', id: 'reply-fixture', parentId: null, timestamp: new Date().toISOString(), message: reply } });
    await waitUntil(() => app.messages.length >= beforeReply + 2, 'assistant response did not reach the topic');
    assert.equal(app.messages.slice(beforeReply).map(message => message.text).join(''), replyText, 'event and durable entry produce one chunked response');
    const authorize = () => fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    const response = await authorize();
    assert.equal(response.status, 200);
    const data = await response.json() as { ticket: string; session: { id: string } };
    assert.equal(data.session.id, session.id);
    assert.ok(!JSON.stringify(data).includes('secret-capability'));
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${data.ticket}`, { origin: app.url });
    const frames: HostFrame[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await waitUntil(() => frames.some(frame => frame.t === 'snapshot-chunk'), 'authenticated socket did not receive session snapshot');
    app.setMember(false);
    const socketClosed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'prompt', text: 'must be rejected after leaving' }));
    await socketClosed;
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    assert.equal((await authorize()).status, 403);
    app.setMember(true);
    const readerData = await (await authorize()).json() as { ticket: string };
    const reader = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${readerData.ticket}`, { origin: app.url });
    const received: string[] = [];
    reader.on('message', bytes => received.push(bytes.toString()));
    await once(reader, 'open');
    await waitUntil(() => received.some(text => text.includes('snapshot-chunk')), 'reader did not receive initial snapshot');
    app.setMember(false);
    const readerClosed = once(reader, 'close');
    app.emit({ t: 'event', event: { type: 'message_end', message: { ...reply, timestamp: Date.now() + 2, content: [{ type: 'text', text: 'Private output after membership removal' }] } } });
    await readerClosed;
    assert.ok(received.every(text => !text.includes('Private output after membership removal')), 'passive reader cannot receive frames after membership removal');
    console.log('PASS Telegraf enrollment, /new, explicit startup rejection, mention routing, topic deduplication, archive/reopen, signed Mini App HTTP, gateway snapshot, and membership revocation.');
  } finally {
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--serve')) {
    const app = await createSmokeApp();
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Browser verification' });
    const session = app.store.listSessions(botId)[0]!;
    if (process.argv.includes('--closed')) await app.update({ message_thread_id: session.threadId, forum_topic_closed: {} });
    console.log(JSON.stringify({ url: app.url, botId, sessionId: session.id, initData: app.initData(session.id) }));
    const shutdown = async () => { await app.close(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else {
    await verifyTelegramFlow();
  }
}
