import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telegraf, type Context } from 'telegraf';
import { z } from 'zod';
import type { HostFrame, GuestFrame, AssistantMessage, SessionEntry } from '@oh-my-pi/pi-wire';
import type { AppConfig, CollabHandlers, TopicSession } from '../shared/contracts.js';
import { createBot } from '../src/bot.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { SessionCapacityError } from '../src/runtime.js';
import { writeConfig } from '../src/config.js';
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
export async function createSmokeApp(options: { competingStartAfterRejection?: boolean; pollingTransientFailure?: boolean; holdPromptReceipts?: boolean; botCanPinMessages?: boolean; authorizationDelayMs?: number; maxSessions?: number; ackUiResponses?: boolean; persistentStore?: boolean } = {}) {
  const messages: Record<string, unknown>[] = [];
  const reactions: Record<string, unknown>[] = [];
  const pins: Record<string, unknown>[] = [];
  const topicEdits: Record<string, unknown>[] = [];
  const deletedMessages: Record<string, unknown>[] = [];
  const commandMenus = new Map<string, { command: string; description: string }[]>();
  const accepted: GuestFrame[] = [];
  const events = new EventEmitter();
  const connections = new Set<CollabHandlers>();
  const rateLimits = new Map<string, number[]>();
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
    const retryAfter = method && rateLimits.get(method)?.shift();
    if (typeof retryAfter === 'number') {
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({ok:false,error_code:429,description:`Too Many Requests: retry after ${retryAfter}`,parameters:{retry_after:retryAfter}}));
      events.emit('rate-limit',method);
      return;
    }
    if (options.authorizationDelayMs && (method === 'getChat' || method === 'getChatMember')) await delay(options.authorizationDelayMs);
    let result: unknown;
    if (method === 'getMe') result = me;
    else if (method === 'getChat') result = group;
    else if (method === 'getChatMember') result = Number(params.user_id) === botId
      ? { user: me, status: 'administrator', can_manage_topics: true, can_pin_messages: options.botCanPinMessages ?? true }
      : { user: { ...currentUser, id: Number(params.user_id) }, status: member ? memberStatus : 'left' };
    else if (method === 'deleteWebhook') result = true;
    else if (method === 'setMyCommands') {
      commandMenus.set(JSON.stringify(params.scope ?? { type: 'default' }), params.commands);
      result = true;
    } else if (method === 'getMyCommands') result = commandMenus.get(JSON.stringify(params.scope ?? { type: 'default' })) ?? [];
    else if (method === 'deleteMyCommands') {
      commandMenus.delete(JSON.stringify(params.scope ?? { type: 'default' }));
      result = true;
    }
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
    else if (method === 'getForumTopicIconStickers') result = [
      { emoji: '⚡️', custom_emoji_id: '5312016608254762256' },
      { emoji: '✅', custom_emoji_id: '5237699328843200968' },
      { emoji: '🏁', custom_emoji_id: '5408906741125490282' },
    ];
    else if (method === 'editForumTopic') {
      topicEdits.push(params);
      events.emit('topic');
      result = true;
    }
    else if (method === 'deleteMessage') {
      deletedMessages.push(params);
      result = true;
    }
    else if (method === 'sendMessage') {
      result = { ...params, message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: group, from: me };
      messages.push(result as Record<string, unknown>);
      events.emit('message');
    } else if (method === 'forwardMessage') {
      result = { ...params, forwarded_message_id: params.message_id, message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: group, from: me };
      messages.push(result as Record<string, unknown>);
      events.emit('message');
    } else if (method === 'pinChatMessage') {
      pins.push(params);
      result = true;
    } else if (method === 'setMessageReaction') {
      reactions.push(params);
      events.emit('reaction');
      result = true;
    } else if (method === 'answerCallbackQuery') result = true;
    else if (method === 'editMessageReplyMarkup' || method === 'editMessageText') {
      const message = messages.find(value => value.chat_id === params.chat_id && value.message_id === params.message_id);
      if (!message) throw new Error('Fixture message to edit was not found');
      Object.assign(message, params);
      events.emit('message');
      result = message;
    }
    else throw new Error(`Unexpected fixture Telegram method ${method}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, result }));
  });
  const telegramUrl = await listen(telegram);
  const directory = await mkdtemp(join(tmpdir(), 'omp-telegram-fixture-'));
  const store = new Store(options.persistentStore ? join(directory, 'telegram.sqlite') : ':memory:');
  const config: AppConfig = {
    bots: [{ id: botId, token: botToken, miniAppShortName: 'app' }],
    instances: { [directory]: { admins: [ownerUsername], chats: [{ botId, chatId }] } },
    publicUrl: 'https://example.invalid', host: '127.0.0.1', port: 0, dataDir: directory,
    configPath: join(directory, 'config.yaml'),
    omp: { executable: 'omp', args: [], maxSessions: options.maxSessions ?? 5, startupTimeoutMs: 60000 },
  };
  let sessionLimit = config.omp.maxSessions;
  const managedSessions = new Set<string>();
  const runtime = {
    async ensure(session: TopicSession) {
      if (session.runtime.kind === 'managed' && !managedSessions.has(session.id)) {
        if (managedSessions.size >= sessionLimit) throw new SessionCapacityError(sessionLimit);
        managedSessions.add(session.id);
      }
      return { instanceId: session.id, sessionId: session.id, generation: 1, url: 'server-only-secret-capability' };
    },
    async isRunning(session: TopicSession) { return session.runtime.kind === 'attached' || managedSessions.has(session.id); },
    async attach(instanceId: string, _instancePath: string) { return { instanceId, sessionId: 'attached-conversation', generation: 1, url: 'server-only-secret-capability' }; },
    async availableModelPresets(_instancePath: string): Promise<string[]> { return ['Fast','Slow']; },
    async modelPresets(_session: TopicSession, _name?: string): Promise<string> { throw new Error('No model preset host configured in the Telegram fixture'); },
    getSessionLimit() { return sessionLimit; },
    increaseSessionLimit(expectedLimit: number) {
      if (sessionLimit !== expectedLimit) return false;
      sessionLimit *= 2;
      return true;
    },
    observeFrame(_sessionId: string, _frame: HostFrame) {},
    markPrompt(_sessionId: string) {},
    retain(_sessionId: string) { return () => {}; },
    async stop(id: string) { managedSessions.delete(id); }, async close() {},
    async kill(session: TopicSession) { managedSessions.delete(session.id); },
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
          if (!options.holdPromptReceipts) handlers.onFrame({ t: 'entry', entry: { type: 'custom_message', customType: 'collab-prompt', content: frame.text, details: { from: _name }, display: true, id: `accepted-${accepted.length}`, parentId: null, timestamp: new Date().toISOString() } });
          handlers.onFrame({ t: 'event', event: { type: 'agent_start' } });
          handlers.onFrame({ t: 'event', event: { type: 'agent_end' } });
        }
        if (frame.t === 'ui-response' && options.ackUiResponses) handlers.onFrame({t:'ui-request-end',reqId:frame.reqId});
        events.emit('accepted');
      },
      close() { connections.delete(handlers); },
    };
  };
  const bot = new Telegraf(botToken, { telegram: { apiRoot: telegramUrl } });
  const service = createBot({config,botConfig:config.bots[0]!,token:botToken,store,runtime,connect,bot,telegramIntervalMs:0});
  await service.initialize();
  const reservation = createHttpServer();
  const reservedUrl = await listen(reservation);
  const port = Number(new URL(reservedUrl).port);
  await close(reservation);
  config.publicUrl = reservedUrl.replace('http:', 'https:');
  writeConfig(config);
  const server = createServer({ config, bots: [service], store, runtime, connect });
  const url = await listen(server, port);
  async function update(message: Record<string, unknown>, from = user) {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: group, from, ...message } } as Parameters<typeof bot.handleUpdate>[0]);
  }
  async function callback(data: string, message: Record<string, unknown>, from = user) {
    assert.ok(typeof message.message_id === 'number', 'callback messages require a Telegram message ID');
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), chat_instance: 'fixture', from, data,
      message: { date: Math.floor(Date.now() / 1000), chat: group, from: me, ...message, message_id: message.message_id },
    } } as Parameters<typeof bot.handleUpdate>[0]);
  }
  return {
    url, telegramUrl, store, config, bot, service, runtime, messages, reactions, pins, topicEdits, deletedMessages, accepted, events, update, callback,
    setMember(value: boolean) { member = value; },
    setCurrentMember(value: { username?: string; is_bot?: boolean; status?: 'administrator' | 'creator' | 'member' }) {
      currentUser = { ...user, username: value.username, is_bot: value.is_bot ?? false };
      memberStatus = value.status ?? 'administrator';
    },
    get connectionCount() { return connectionCount; },
    rejectNextPrompt() { rejectionCount = 1; },
    rateLimitNext(method: string, retryAfter = 1) {
      const pending = rateLimits.get(method) ?? [];
      pending.push(retryAfter);
      rateLimits.set(method,pending);
    },
    disconnect() { for (const connection of [...connections]) connection.onClose('Fixture relay disconnected'); },
    emit(frame: HostFrame) { for (const connection of connections) connection.onFrame(frame); },
    appendEntry(entry: SessionEntry) { entries.push(entry); },
    initData(sessionId: string) { return signedInitData(sessionId); },
    async close() { await server.closeConnections(); await close(server); await service.close(); store.close(); await close(telegram); await rm(directory, { recursive: true, force: true }); },
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
    const menuScopes = [{ type: 'all_group_chats' }, { type: 'chat', chat_id: chatId }] as const;
    async function verifyMenus(mode: string, previous?: ReadonlySet<string>[]) {
      const menus: Set<string>[] = [];
      for (const [index, scope] of menuScopes.entries()) {
        const menu = await app.bot.telegram.getMyCommands({ scope });
        const commands = new Set(menu.map(command => command.command));
        for (const command of ['new', 'p', 'setup', 'session', 'stop', 'kill', 'model_preset', 'list_model_presets']) {
          assert.ok(commands.has(command), `${scope.type} must advertise /${command} in ${mode} mode`);
        }
        for (const command of previous?.[index] ?? []) {
          assert.ok(commands.has(command), `${scope.type} lost /${command} after switching to ${mode} mode`);
        }
        menus.push(commands);
      }
      return menus;
    }
    await app.update({ text: '/new unauthorized' });
    assert.equal(app.store.listSessions(botId).length, 0, 'unenrolled groups cannot launch OMP');
    await app.update({ text: '/setup' });
    assert.equal(app.store.isEnrolled(botId, chatId), true);
    const allMessageMenus = await verifyMenus('all-message');
    await app.update({ message_id:7003, text: '/new Implement login' });
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(session.threadId, 21);
    await waitUntil(() => app.accepted.some(frame => frame.t === 'prompt'), 'initial task was not delivered after explicit startup rejection');
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Implement login' }]);
    const button = app.messages.find(value => JSON.stringify(value.reply_markup)?.includes('startapp='));
    assert.ok(button);
    assert.ok(JSON.stringify(button).includes(`startapp=s_${session.id}`));
    assert.ok(!JSON.stringify(button).includes('web_app'));
    assert.equal(button.message_thread_id, session.threadId);
    assert.deepEqual(app.pins, [{ chat_id: chatId, message_id: button.message_id, disable_notification: true }], 'the Mini App entry is pinned inside its session topic');
    const topicMessages = app.messages.filter(message => message.message_thread_id === session.threadId);
    assert.equal(topicMessages[1]?.forwarded_message_id,7003);
    app.emit({t:'event',event:{type:'agent_start'}});
    await waitUntil(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5312016608254762256', 'active turn did not get the running icon');
    app.emit({t:'event',event:{type:'agent_end'}});
    await waitUntil(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5237699328843200968', 'live idle host did not get the completed icon');
    assert.ok(app.topicEdits.some(edit => edit.icon_custom_emoji_id === '5312016608254762256'), 'the admitted task must show a running icon');
    assert.equal(await app.runtime.isRunning(session), true, 'the completed icon does not mean the process stopped');
    console.log('Observed initial topic messages:', JSON.stringify(topicMessages.slice(0, 2).map(message => message.text)));
    console.log('Observed topic icon lifecycle:', app.topicEdits.map(edit => edit.icon_custom_emoji_id).join(' → '));
    await app.update({ message_thread_id: 21, text: 'Check redirect' });
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    await app.update({ text: '/setup' });
    await app.callback('setup:prompts:false', app.messages.at(-1)!);
    const explicitMenus = await verifyMenus('explicit-command', allMessageMenus);
    await app.callback('setup:prompts:true', app.messages.at(-1)!);
    const restoredMenus = await verifyMenus('all-message', explicitMenus);
    await app.callback('setup:prompts:false', app.messages.at(-1)!);
    await verifyMenus('explicit-command', restoredMenus);
    const reactionsBeforeDiscussion = app.reactions.length;
    await app.update({ message_thread_id: 21, text: 'Ordinary team discussion.' });
    assert.equal(app.reactions.length, reactionsBeforeDiscussion);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    app.rejectNextPrompt();
    const rejected = once(app.events, 'message');
    await app.update({ message_thread_id: 21, text: '/p Try during startup' });
    await rejected;
    console.log('Observed prompt rejection notification:', app.messages.at(-1)?.text);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    await app.update({ message_thread_id: 21, forum_topic_created: { name: 'Duplicate service event', icon_color: 7322096 } });
    assert.equal(app.store.listSessions(botId).length, 1);
    await app.update({ message_thread_id: 21, forum_topic_closed: {} });
    assert.equal(app.topicEdits.at(-1)?.icon_custom_emoji_id, '5408906741125490282', 'process exit shows the stopped flag');
    await app.update({ message_thread_id: 21, text: '/p Do not run' });
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, 2);
    await app.update({ message_thread_id: 21, forum_topic_reopened: {} });
    assert.equal(await app.runtime.isRunning(session),false,'reopening alone must not relaunch the host');
    await app.update({ message_thread_id: 21, text: '/p@FixtureOmpBot Resume this topic' });
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [
      {t:'prompt',text:'Implement login'},
      {t:'prompt',text:'Check redirect'},
      {t:'prompt',text:'Resume this topic'},
    ]);
    const beforeReply = app.messages.length;
    const replyText = 'Agent result ' + 'x'.repeat(5000);
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: replyText }], model: 'fixture-no-model-call', stopReason: 'stop', timestamp: Date.now() + 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
    app.emit({ t: 'event', event: { type: 'message_end', message: reply } });
    app.emit({ t: 'entry', entry: { type: 'message', id: 'reply-fixture', parentId: null, timestamp: new Date().toISOString(), message: reply } });
    await waitUntil(() => app.messages.length >= beforeReply + 2, 'assistant response did not reach the topic');
    assert.equal(app.messages.slice(beforeReply).map(message => message.text).join(''), replyText, 'event and durable entry produce one chunked response');
    await app.update({ message_thread_id: session.threadId, text: '/kill' });
    assert.equal(await app.runtime.isRunning(session), false);
    assert.equal(app.topicEdits.at(-1)?.icon_custom_emoji_id, '5408906741125490282');
    await app.update({
      message_id: 9000, message_thread_id: session.threadId,
      forum_topic_edited: { icon_custom_emoji_id: '5408906741125490282' },
    }, { id: botId, first_name: 'OMP', is_bot: true });
    assert.deepEqual(app.deletedMessages, [{ chat_id: chatId, message_id: 9000 }]);
    console.log('PASS /kill sets the stopped flag before replying; its bot-authored icon notice is deleted.');
    const proposer = {id:ownerId+22,first_name:'Grace',username:'grace',is_bot:false};
    app.setCurrentMember({username:'grace',status:'administrator'});
    const beforeIgnored = app.reactions.length;
    await app.update({text:'/p Ignored non-admin task',message_thread_id:session.threadId},proposer);
    assert.equal(app.reactions.length,beforeIgnored);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,3);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.update({text:'/setup'});
    await app.callback('setup:proposals:true',app.messages.at(-1)!);
    app.setCurrentMember({username:'grace',status:'member'});
    await app.update({message_id:9100,text:'/p Proposed user task',message_thread_id:session.threadId},proposer);
    const proposal = app.messages.findLast(message => JSON.stringify(message.reply_markup)?.includes('prompt:approve:'))!;
    const controls = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(proposal.reply_markup);
    const approval = controls.inline_keyboard[0]![0]!.callback_data;
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,3);
    await app.callback(approval,proposal,proposer);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,3);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(approval,proposal);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1),{t:'prompt',text:'Proposed user task'});
    assert.equal(app.store.getReplyTarget(session.id),9100);
    await app.callback(approval,proposal);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,4);
    console.log('PASS non-admin messages ignored by default; enabled user proposals wait for one-time approval by an instance admin with ordinary group membership.');
    console.log('PASS Telegram enrollment, /new with pinned session button, explicit startup rejection, all-message prompts, both scoped command menus across prompt-mode changes, ignored discussion, /p routing, topic deduplication, archive/reopen, assistant response relay, /kill, and one-time user proposal approval.');
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
