import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { GrammyError } from 'grammy';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { Store } from '../src/store.js';
import { botId, chatId, ownerId } from './telegram-data.js';

test('initial preparation maintenance cannot admit a held forward', {timeout:10000}, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp({persistentStore:true,skipStartupRejection:true,initialEntries:[]});
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let updating: Promise<void> | undefined;
  try {
    await app.update({text:'/setup'});
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'forwardMessage' && 'message_id' in payload && payload.message_id === 8000) {
        entered.resolve();
        await release.promise;
      }
      return previous(method,payload,signal);
    });
    updating = app.update({message_id:8000,text:'/new Delayed task',reply_to_message:{message_id:7999,text:'Context only'}});
    await entered.promise;
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    const reader = new Store(join(app.config.dataDir,'telegram.sqlite'));
    try { assert.equal(reader.claimInitialTask(session.id),undefined); }
    finally { reader.close(); }
    await app.service.initialize();
    const attempted = Promise.withResolvers<void>();
    const claim = app.store.claimInitialTask.bind(app.store);
    t.mock.method(app.store,'claimInitialTask',(id: string) => {
      const result = claim(id);
      if (id === session.id) {
        assert.equal(result,undefined);
        attempted.resolve();
      }
      return result;
    });
    t.mock.timers.tick(30000);
    await attempted.promise;
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    t.mock.restoreAll();
    const admitted = once(app.events,'accepted');
    release.resolve();
    await updating;
    await admitted;
    assert.equal(app.store.db.prepare('SELECT 1 FROM initial_task_preparations WHERE session_id=?').get(session.id),undefined);
    const binding = await app.runtime.ensure(session);
    const forwarded = app.messages.find(message => message.forwarded_message_id === 8000)!;
    assert.ok(forwarded);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'> Context only\n\nDelayed task'}]);
    const expected = {ompSessionId:binding.sessionId,entryId:'accepted-1',parentEntryId:null,kind:'collab-prompt',partIndex:0};
    for (const id of [8000,Number(forwarded.message_id)])
      assert.deepEqual(app.store.getMessageAnchor(session.id,binding.sessionId,chatId,id),expected);
    const context = app.messages.find(message => message.forwarded_message_id === 7999)!;
    for (const id of [7999,Number(context.message_id)])
      assert.equal(app.store.getMessageAnchor(session.id,binding.sessionId,chatId,id),undefined);
  } finally {
    release.resolve();
    await updating;
    await app.close();
  }
});

test('initial preparation forwarding failure releases gate and preserves Telegram diagnostic', async t => {
  const app = await createSmokeApp({skipStartupRejection:true,initialEntries:[]});
  const failure = new GrammyError('forwardMessage',{ok:false,error_code:400,description:'Bad Request: message to forward not found'},'forwardMessage',{});
  const reported: unknown[][] = [];
  t.mock.method(console,'error',(...args: unknown[]) => { reported.push(args); });
  try {
    await app.update({text:'/setup'});
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (method === 'forwardMessage') throw failure;
      return previous(method,payload,signal);
    });
    await app.update({message_id:8100,text:'/new Recover after forwarding error'});
    const session = app.store.listSessions(botId)[0]!;
    assert.ok(reported.some(args => args.includes(failure)));
    assert.equal(app.store.db.prepare('SELECT 1 FROM initial_task_preparations WHERE session_id=?').get(session.id),undefined);
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    assert.deepEqual(app.store.claimInitialTask(session.id),{text:'Recover after forwarding error'});
  } finally { await app.close(); }
});

test('initial preparation initialization recovers stale gate with source and authority once', {timeout:10000}, async () => {
  let sessionId = '';
  const app = await createSmokeApp({persistentStore:true,skipStartupRejection:true,initialEntries:[],
    prepareDatabase(filename,instancePath) {
      const store = new Store(filename);
      try {
        store.enrollGroup(botId,chatId);
        const session = store.createSession({botId,chatId,threadId:42, instanceId: 1, cwd: instancePath}, 'Interrupted preparation',{kind:'managed'},{text:'Resume prepared task'},ownerId,ownerId);
        sessionId = session.id;
        store.setInitialMessage(session.id,8200);
        store.recordPromptMessageAlias(session.id,8200,8201);
        store.beginInitialTaskPreparation(session.id);
      } finally { store.close(); }
    },
  });
  try {
    if (!app.accepted.some(frame => frame.t === 'prompt')) await once(app.events,'accepted');
    const session = app.store.getSession(sessionId)!;
    const binding = await app.runtime.ensure(session);
    assert.equal(app.store.db.prepare('SELECT 1 FROM initial_task_preparations WHERE session_id=?').get(sessionId),undefined);
    assert.equal(app.store.getInitialUser(sessionId),ownerId);
    assert.equal(app.store.getInitialAuthority(sessionId),ownerId);
    for (const id of [8200,8201])
      assert.deepEqual(app.store.getMessageAnchor(sessionId,binding.sessionId,chatId,id),{
        ompSessionId:binding.sessionId,entryId:'accepted-1',parentEntryId:null,kind:'collab-prompt',partIndex:0,
      });
    await app.service.initialize();
    await app.service.reconcileConfiguration();
    assert.equal(app.store.hasPendingInitialTask(sessionId),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Resume prepared task'}]);
  } finally { await app.close(); }
});
