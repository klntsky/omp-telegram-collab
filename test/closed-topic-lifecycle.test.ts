import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

test('reopen failure preserves closed state and permits an explicit retry', {timeout:15000}, async () => {
  const app = await createSmokeApp();
  let reject = true;
  const diagnostic = 'Original Telegram reopening failure\nPermission details retained';
  app.bot.api.config.use(async (previous,method,payload,signal) => {
    if (method === 'reopenForumTopic' && reject) throw new Error(diagnostic);
    return previous(method,payload,signal);
  });
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Closed'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    const generation = app.store.getSessionGeneration(session.id);
    const body = {botId,sessionId:session.id,initData:app.initData(session.id),generation,reopen:true};
    const failed = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(failed.status,403);
    assert.deepEqual(await failed.json(),{error:diagnostic});
    assert.equal(app.store.getSession(session.id)?.status,'closed');
    assert.equal(await app.runtime.isRunning(session),false);
    assert.deepEqual(app.reopenedTopics,[]);
    reject = false;
    const retried = await Promise.all([1,2].map(() => fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})));
    assert.deepEqual(retried.map(response => response.status),[200,200]);
    assert.equal(app.store.getSession(session.id)?.status,'open');
    assert.deepEqual(app.reopenedTopics,[{chat_id:chatId,message_thread_id:42}]);
    assert.equal(await app.runtime.isRunning(session),false);
  } finally { await app.close(); }
});

test('closed-session reconciliation cancels pending tasks and does not repeatedly inspect a settled host', {timeout:15000}, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    const session = app.store.createSession({botId,chatId,threadId:42,instancePath},'Pending',{kind:'managed'},{text:'Never submit'},ownerId);
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    app.store.updateSession(session.id,{status:'closed'});
    let stops = 0;
    const stop = app.runtime.stop.bind(app.runtime);
    app.runtime.stop = async current => { stops++; return stop(current); };
    app.runtime.resolveExisting = async () => { assert.fail('Closed session must not resolve a room'); };
    app.runtime.ensure = async () => { assert.fail('Closed session must not start a host'); };
    await app.service.reconcileConfiguration();
    await eventually(() => !app.store.hasPendingInitialTask(session.id));
    t.mock.timers.tick(30_000);
    await app.service.reconcileConfiguration();
    assert.equal(stops,1);
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.activeConnectionCount,0);
    assert.deepEqual(app.accepted,[]);
    await app.update({message_thread_id:42,forum_topic_reopened:{}});
    assert.equal(app.store.getSession(session.id)?.status,'open');
    assert.equal(await app.runtime.isRunning(session),false);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('closure during delayed gateway admission prevents host launch and upstream connections', {timeout:15000}, async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  let socket: WebSocket | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Admission race'}});
    const session = app.store.listSessions(botId)[0]!;
    const ensure = app.runtime.ensure.bind(app.runtime);
    app.runtime.ensure = async (current,beforeMutation) => {
      entered.resolve();
      await resume.promise;
      try { return await ensure(current,beforeMutation); }
      finally { settled.resolve(); }
    };
    const authorization = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id)})});
    const {ticket} = await authorization.json() as {ticket:string};
    socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${ticket}`,{origin:app.config.publicUrl});
    const closed = once(socket,'close');
    await entered.promise;
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    resume.resolve();
    assert.equal((await closed)[0],4003);
    await settled.promise;
    await app.service.close();
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.connectionCount,0);
    assert.equal(app.activeConnectionCount,0);
    assert.deepEqual(app.accepted,[]);
  } finally { resume.resolve(); socket?.terminate(); await app.close(); }
});

test('reopening confirmation does not bypass the managed process limit', {timeout:15000}, async () => {
  const app = await createSmokeApp({maxSessions:1,skipStartupRejection:true});
  let socket: WebSocket | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Resident'});
    const resident = app.store.listSessions(botId)[0]!;
    await app.update({message_thread_id:42,forum_topic_created:{name:'Waiting'}});
    const waiting = app.store.listSessions(botId).find(session => session.threadId === 42)!;
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    const generation = app.store.getSessionGeneration(waiting.id);
    const response = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botId,sessionId:waiting.id,initData:app.initData(waiting.id),generation,reopen:true})});
    assert.equal(response.status,200);
    const {ticket} = await response.json() as {ticket:string};
    socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${ticket}`,{origin:app.config.publicUrl});
    assert.equal((await once(socket,'close'))[0],4009);
    assert.equal(await app.runtime.isRunning(resident),true);
    assert.equal(await app.runtime.isRunning(waiting),false);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.store.getSession(waiting.id)?.status,'open');
  } finally { socket?.terminate(); await app.close(); }
});

test('closing an attached topic releases bot mirroring without retiring its terminal-owned host', {timeout:15000}, async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/attach local-instance Terminal'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(session.runtime.kind,'attached');
    assert.equal(await app.runtime.isRunning(session),true);
    await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
    assert.equal(app.store.getSession(session.id)?.status,'closed');
    assert.equal(app.activeConnectionCount,0);
    assert.equal(await app.runtime.isRunning(session),true);
    await app.service.reconcileConfiguration();
    assert.equal(app.activeConnectionCount,0);
    assert.equal(await app.runtime.isRunning(session),true);
  } finally { await app.close(); }
});

for (const cancellation of ['caller','shutdown'] as const) {
  test(`a stalled native reopen releases the bot update queue on ${cancellation} cancellation`, {timeout:15000}, async () => {
    const app = await createSmokeApp();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    let telegramSignal: {aborted:boolean} | undefined;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (method === 'reopenForumTopic') {
        telegramSignal = signal;
        entered.resolve();
        return new Promise<never>(() => {});
      }
      return previous(method,payload,signal);
    });
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Stalled reopen'}});
      const session = app.store.listSessions(botId)[0]!;
      await app.update({message_thread_id:42,forum_topic_closed:{}});
      const reason = new Error('Original request cancellation');
      const reopening = app.service.reopenSession(session,ownerId,() => {},controller.signal);
      const rejected = assert.rejects(reopening,error => cancellation === 'caller' ? error === reason : error instanceof Error);
      await entered.promise;
      const closing = cancellation === 'shutdown' ? app.service.close() : undefined;
      if (cancellation === 'caller') controller.abort(reason);
      await rejected;
      await closing;
      assert.equal(telegramSignal?.aborted,true);
      assert.equal(app.store.getSession(session.id)?.status,'closed');
      assert.deepEqual(app.reopenedTopics,[]);
      assert.equal(await app.runtime.isRunning(session),false);
      if (cancellation === 'caller') {
        await app.update({message_thread_id:42,text:'/p Never submit'});
        assert.deepEqual(app.accepted,[]);
      }
    } finally { controller.abort(); await app.close(); }
  });
}
