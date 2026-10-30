import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

test('anonymous-admin topic closure persists the gateway archive restriction', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Authentication' });
    const session = app.store.listSessions(botId)[0]!;
    await app.update({ message_thread_id: session.threadId, forum_topic_closed: {}, sender_chat: { id: session.chatId, type: 'supergroup', title: 'Fixture project' } }, { id: 1087968824, first_name: 'Group', is_bot: true });
    assert.equal(app.store.getSession(session.id)?.status, 'closed');
    const before = app.accepted.length;
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const data = await response.json() as { ticket: string };
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${data.ticket}`, { origin: app.config.publicUrl });
    const frames: { t: string; readOnly?: boolean }[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk'));
    assert.equal(frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'prompt', text: 'Cannot run in an archived topic' }));
    await closed;
    assert.equal(app.accepted.length, before);
  } finally {
    await app.close();
  }
});

test('empty topic creation, initialization, and reopening do not launch managed hosts', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Idle topic',icon_color:7322096}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.initialize();
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    await app.update({message_thread_id:42,forum_topic_reopened:{}});
    assert.equal(app.connectionCount,0);
    assert.equal(await app.runtime.isRunning(session),false);
    await app.update({message_thread_id:42,text:'@FixtureOmpBot Start now',entities:[{type:'mention',offset:0,length:14}]});
    assert.equal(app.connectionCount,1);
    assert.equal(await app.runtime.isRunning(session),true);
  } finally {
    await app.close();
  }
});

test('topic icons share a finished flag for idle live hosts and process exit without confusing relay loss', async () => {
  const app = await createSmokeApp();
  const running = '5312016608254762256', finished = '5408906741125490282';
  const icon = () => app.topicEdits.at(-1)?.icon_custom_emoji_id;
  const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Status transitions'}});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(icon(),finished);
    assert.equal(app.connectionCount,0);
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => icon() === finished);
    app.emit({t:'event',event:{type:'agent_start'}});
    await eventually(() => icon() === running);
    app.emit({t:'state',state});
    await eventually(() => icon() === finished);
    app.emit({t:'state',state:{...state,queuedMessageCount:1}});
    await eventually(() => icon() === running);
    app.emit({t:'event',event:{type:'agent_end'}});
    await delay(50);
    assert.equal(icon(),running,'queued work keeps the topic running between turns');
    app.emit({t:'state',state});
    await eventually(() => icon() === finished);
    assert.equal(await app.runtime.isRunning(session),true,'completion does not imply process exit');
    const beforeDisconnect = app.topicEdits.length;
    app.disconnect();
    await delay(100);
    assert.equal(icon(),finished,'a live process retains its icon when the relay disconnects');
    assert.equal(app.topicEdits.length,beforeDisconnect);
    await eventually(() => app.connectionCount > 1);
    await app.runtime.stop(session.id);
    app.disconnect();
    await eventually(() => icon() === finished);
    assert.ok(app.topicEdits.every(edit => edit.chat_id === chatId && edit.message_thread_id === 42));
    assert.deepEqual(app.accepted,[],'status observation never submits instructions');
  } finally {
    await app.close();
  }
});

test('periodic topic status checks detect retirement without a relay close event', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Retiring host'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    app.emit({t:'event',event:{type:'agent_start'}});
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5312016608254762256');
    await app.runtime.stop(session.id);
    t.mock.timers.tick(30000);
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5408906741125490282');
    assert.equal(app.connectionCount,1,'retirement detection does not revive the process');
  } finally {
    await app.close();
  }
});

test('closing a working topic does not claim the process stopped while guarded shutdown is deferred', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Deferred stop'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    app.emit({t:'event',event:{type:'agent_start'}});
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5312016608254762256');
    app.runtime.stop = async () => {};
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    assert.equal(app.topicEdits.at(-1)?.icon_custom_emoji_id,'5312016608254762256');
    app.emit({t:'event',event:{type:'agent_end'}});
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5408906741125490282');
    assert.equal(app.store.getSession(session.id)?.status,'closed');
  } finally {
    await app.close();
  }
});

test('status icon notices from this bot are deleted without deleting human edits or renames', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Status notices'}});
    const ownBot = {id:botId,first_name:'OMP',is_bot:true};
    await app.update({message_id:1000,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'5408906741125490282'}},ownBot);
    await app.update({message_id:1003,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:''}},ownBot);
    await app.update({message_id:1004,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'5312016608254762256'}});
    await app.update({message_id:1005,message_thread_id:42,forum_topic_edited:{name:'Renamed topic'}});
    await app.update({message_id:1006,message_thread_id:42,forum_topic_edited:{name:'Bot rename',icon_custom_emoji_id:'5237699328843200968'}},ownBot);
    await app.update({message_id:1007,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'5312016608254762256'}},{...ownBot,id:botId+1});
    assert.deepEqual(app.deletedMessages,[1000,1003].map(message_id => ({chat_id:chatId,message_id})));
    assert.equal(app.store.listSessions(botId)[0]?.name,'Renamed topic','delayed bot rename echoes do not overwrite human intent');
    assert.equal(app.connectionCount,0,'processing service notices never starts a host');
  } finally {
    await app.close();
  }
});

test('topic titles seed managed sessions and bidirectional updates preserve full OMP names without echoes', async () => {
  const app = await createSmokeApp();
  const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Initial topic'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Before launch'}});
    assert.equal(app.connectionCount,0);
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.store.getPendingSessionTitle(session.id),'Before launch');
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    assert.equal(app.sessionTitles.get(session.id),'Before launch');
    const longTitle = '😀'.repeat(140);
    const before = app.titleChanges.length;
    app.emit({t:'state',state:{...state,sessionName:longTitle}});
    await eventually(() => app.store.getSession(session.id)?.name === '😀'.repeat(128));
    assert.equal(app.topicEdits.filter(edit => edit.name === '😀'.repeat(128)).length,1);
    await app.update({message_thread_id:42,forum_topic_edited:{name:'😀'.repeat(128)}},{id:botId,first_name:'OMP',is_bot:true});
    app.emit({t:'state',state:{...state,sessionName:longTitle}});
    await delay(30);
    assert.equal(app.titleChanges.length,before,'Telegram projection never truncates the real OMP title');
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Human wins'}});
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Delayed bot echo'}},{id:botId,first_name:'OMP',is_bot:true});
    assert.equal(app.store.getSession(session.id)?.name,'Human wins');
    assert.equal(app.sessionTitles.get(session.id),'Human wins');
  } finally {
    await app.close();
  }
});

test('pending Telegram title survives stale reconnect snapshots and archived or detached sessions do not rename hosts', async () => {
  const app = await createSmokeApp();
  const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Initial'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    app.disconnect();
    const realSetTitle = app.runtime.setSessionTitle;
    app.runtime.setSessionTitle = async () => { throw new Error('Control disconnected'); };
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Offline intent'}});
    assert.equal(app.store.getPendingSessionTitle(session.id),'Offline intent');
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    app.emit({t:'state',state:{...state,sessionName:'Stale welcome'}});
    await delay(30);
    assert.equal(app.store.getSession(session.id)?.name,'Offline intent');
    assert.equal(app.store.getPendingSessionTitle(session.id),'Offline intent');
    app.runtime.setSessionTitle = realSetTitle;
    app.emit({t:'state',state:{...state,sessionName:'Still stale'}});
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    assert.equal(app.sessionTitles.get(session.id),'Offline intent');
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    const before = app.titleChanges.length;
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Archived rename'}});
    assert.equal(app.titleChanges.length,before);
    await app.update({message_thread_id:42,text:'/detach'});
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Conversation only'}});
    assert.equal(app.titleChanges.length,before);
    assert.equal(app.store.getPendingSessionTitle(session.id),undefined);
  } finally {
    await app.close();
  }
});

test('attached sessions import the existing OMP title instead of exporting their placeholder', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/attach terminal-instance Placeholder'});
    const session = app.store.listSessions(botId)[0]!;
    await eventually(() => app.store.getSession(session.id)?.name === 'Telegram fixture session');
    assert.equal(app.titleChanges.length,0);
    assert.equal(app.store.getPendingSessionTitle(session.id),undefined);
  } finally {
    await app.close();
  }
});

test('a rate-limited OMP topic rename is cancelled after a human rename even after the host acknowledges it', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Initial'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    app.rateLimitNext('editForumTopic',1);
    app.emit({t:'state',state:{cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[],sessionName:'Old outbound title'}});
    await delay(50);
    await app.update({message_thread_id:42,forum_topic_edited:{name:'New human title'}});
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    await delay(1100);
    assert.equal(app.store.getSession(session.id)?.name,'New human title');
    assert.ok(!app.topicEdits.some(edit => edit.name === 'Old outbound title'));
  } finally {
    await app.close();
  }
});

test('removing an assignment disables output immediately and reconciliation detaches without killing history', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Keep working locally' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const assigned = app.config.instances[session.instancePath]!;
    const chats = assigned.chats;
    const detached: string[] = [];
    app.service.onSessionKill(id => detached.push(id));
    const before = app.messages.length;
    assigned.chats = [];
    app.emit({ t: 'event', event: { type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Must not leak to the removed chat' }], model: 'fixture', timestamp: Date.now(),
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    } } });
    await delay(50);
    assert.equal(app.messages.length, before, 'output is blocked before the reload reconciliation finishes');
    await assert.rejects(app.service.authorize(chatId, ownerId));
    await app.service.reconcileConfiguration();
    assert.deepEqual(detached, [session.id]);
    assert.equal(await app.runtime.isRunning(session), true);
    assert.equal(app.store.getSessionGeneration(session.id), 0);
    assert.equal(app.store.getSession(session.id)?.instancePath, session.instancePath);
    const connections = app.connectionCount;
    assigned.chats = chats;
    await app.service.reconcileConfiguration();
    await eventually(() => app.connectionCount > connections);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Keep working locally' }]);
  } finally {
    await app.close();
  }
});

test('retargeted config cannot authorize, launch or mirror a session pinned to the old path', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Pinned topic' } });
    const session = app.store.listSessions(botId)[0]!;
    const original = app.config.instances[session.instancePath]!;
    delete app.config.instances[session.instancePath];
    app.config.instances[realpathSync(tmpdir())] = original;
    await app.update({ message_thread_id: 42, text: '@FixtureOmpBot Must not launch', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    assert.equal(app.connectionCount, 0);
    assert.equal(app.store.hasPendingInitialTask(session.id), false);
    await assert.rejects(app.service.ensureMirroring(session, { instanceId: 'host', sessionId: 'history', generation: 1, url: 'unused' }));
    assert.equal(app.store.getSession(session.id)?.instancePath, session.instancePath);
  } finally {
    await app.close();
  }
});
