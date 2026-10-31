import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Bot } from 'grammy';
import WebSocket from 'ws';
import { createBot, type BotService } from '../src/bot.js';
import { Store } from '../src/store.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, botToken, chatId, ownerId, ownerUsername } from './telegram-data.js';

test('/detach requires a group administrator and a non-General topic', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/detach'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Keep attached'}});
    const session = app.store.listSessions(botId)[0]!;
    app.setCurrentMember({username:'ordinary_member',status:'member'});
    await app.update({text:'/detach',message_thread_id:42});
    assert.equal(app.store.getSession(session.id)?.status,'open');
  } finally { await app.close(); }
});

test('/detach disables prompts and session access and leaves its icon alone across lifecycle events and restart', async () => {
  const app = await createSmokeApp({persistentStore:true});
  let restarted: BotService | undefined;
  let reopenedStore: Store | undefined;
  let ws: WebSocket | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Discussion'}});
    const session = app.store.listSessions(botId)[0]!;
    const response = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id)})});
    assert.equal(response.status,200);
    const {ticket} = await response.json() as {ticket:string};
    ws = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${ticket}`,{origin:app.config.publicUrl});
    await once(ws,'message');
    const closed = once(ws,'close');
    await app.update({text:'/detach',message_thread_id:42});
    const [code] = await closed;
    assert.equal(code,4003);
    assert.equal(app.store.getSession(session.id)?.status,'detached');
    assert.equal(app.store.getTopicKind({botId,chatId,threadId:42}),'detached');
    assert.equal(await app.runtime.isRunning(session),true,'detaching must not kill the host');
    const icons = app.topicEdits.length;
    const reactions = app.reactions.length;
    const accepted = [...app.accepted];
    const connections = app.connectionCount;
    const finishIcon = app.store.getTopicFinishIcon(session.id);
    const name = app.store.getSession(session.id)?.name;
    const pendingTitle = app.store.getPendingSessionTitle(session.id);
    let probes = 0;
    app.runtime.topicTitleStatus = async () => { probes++; return {worktree:true,branch:'must-not-appear'}; };
    await app.update({text:'Just talking',message_thread_id:42});
    await app.update({text:'/p Do not execute this',message_thread_id:42});
    app.emit({t:'event',event:{type:'agent_start'}});
    await app.service.reconcileConfiguration();
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    await app.update({message_thread_id:42,forum_topic_reopened:{}});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Must not recapture'}});
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Human conversation'}});
    assert.equal(probes,0);
    assert.equal(app.store.getSession(session.id)?.name,name);
    assert.equal(app.store.getPendingSessionTitle(session.id),pendingTitle);
    assert.equal(app.store.getSession(session.id)?.status,'detached');
    assert.equal(app.topicEdits.length,icons);
    assert.equal(app.reactions.length,reactions);
    assert.deepEqual(app.accepted,accepted);
    assert.equal(app.connectionCount,connections);
    const denied = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id)})});
    assert.equal(denied.status,409,'even a fresh launch cannot reattach a detached topic');
    await assert.rejects(app.service.ensureMirroring(session,await app.runtime.ensure(session)),/not assigned/);
    await app.service.close();
    reopenedStore = new Store(`${app.config.dataDir}/telegram.sqlite`);
    restarted = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:reopenedStore,runtime:app.runtime,
      bot:new Bot(botToken,{client:{apiRoot:app.telegramUrl}})});
    await restarted.initialize();
    restarted.startBackground();
    const chat = {id:chatId,type:'supergroup',title:'Fixture project',is_forum:true} as const;
    const from = {id:ownerId,is_bot:false,first_name:'Ada',username:ownerUsername};
    await restarted.bot.handleUpdate({update_id:9001,message:{message_id:9001,date:0,chat,from,message_thread_id:42,forum_topic_reopened:{}}});
    await restarted.bot.handleUpdate({update_id:9002,message:{message_id:9002,date:0,chat,from,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'human-icon'}}});
    await restarted.reconcileConfiguration();
    assert.equal(reopenedStore.getSession(session.id)?.status,'detached');
    assert.equal(reopenedStore.getTopicFinishIcon(session.id),finishIcon);
    assert.equal(app.topicEdits.length,icons,'restart and human edits must not restore an activity icon');
  } finally { ws?.terminate(); await restarted?.close(); reopenedStore?.close(); await app.close(); }
});

test('a detached topic can request a separate session without reattaching itself', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Discussion'}});
    const detached = app.store.listSessions(botId)[0]!;
    await app.update({text:'/detach',message_thread_id:42});
    const icons = app.topicEdits.filter(edit=>edit.message_thread_id === 42).length;
    await app.update({text:'/new Separate task',message_thread_id:42});
    const separate = app.store.listSessions(botId).find(session=>session.id !== detached.id);
    assert.equal(separate?.name,'Separate task');
    assert.notEqual(separate?.threadId,42);
    assert.equal(separate?.status,'open');
    assert.equal(app.store.getSession(detached.id)?.status,'detached');
    assert.equal(app.topicEdits.filter(edit=>edit.message_thread_id === 42).length,icons);
  } finally { await app.close(); }
});

test('/detach keeps the conversation icon after a rate-limited activity edit', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Pending icon'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    const limited = once(app.events,'rate-limit');
    app.rateLimitNext('editForumTopic',1);
    app.emit({t:'event',event:{type:'agent_start'}});
    await limited;
    await app.update({text:'/detach',message_thread_id:42});
    assert.equal(app.store.getSession(session.id)?.status,'detached');
    assert.equal(app.topicEdits.at(-1)?.icon_custom_emoji_id,'');
    const icons = app.topicEdits.length;
    await app.update({message_thread_id:42,forum_topic_reopened:{}});
    assert.equal(app.topicEdits.length,icons);
  } finally { await app.close(); }
});
