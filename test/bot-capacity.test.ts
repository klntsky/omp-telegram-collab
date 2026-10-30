import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig, writeConfig } from '../src/config.js';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';
import { capacityRequest, waitingForCapacity } from './bot-capacity-helpers.js';

test('capacity approval requires a current native group administrator', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
    assert.equal(request.message.message_thread_id,waiting.threadId);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),true);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Running task'}]);

    app.setCurrentMember({username:'not_the_owner',status:'member'});
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1,'the update username cannot substitute for the current member identity');
    app.setMember(false);
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),true);
    assert.equal(app.connectionCount,1);
    app.setMember(true);
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    await app.callback(request.approve,request.message);
    await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
    assert.equal(app.runtime.getSessionLimit(),2);
    assert.equal(app.config.omp.maxSessions,2,'chat approval persists the actual configured capacity');
    assert.equal(readConfig(app.config.configPath).omp.maxSessions,2);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Running task'},{t:'prompt',text:'Waiting task'},
    ]);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),false);
    await app.callback(request.approve,request.message);
    await app.callback(request.cancel,request.message);
    assert.equal(app.runtime.getSessionLimit(),2);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,2);
    assert.equal(app.connectionCount,2);
  } finally {
    await app.close();
  }
});

test('a stale confirmation cannot double a limit already increased by another topic', async () => {
  const app = await waitingForCapacity();
  try {
    const first = capacityRequest(app);
    await app.update({text:'/new Another waiting task'});
    const waiting = app.store.listSessions(botId).find(session => session.name === 'Another waiting task')!;
    const stale = capacityRequest(app,waiting.threadId);
    await app.callback(first.approve,first.message);
    await app.callback(stale.approve,stale.message);
    assert.equal(app.runtime.getSessionLimit(),2);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),true);
    assert.ok(!app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Another waiting task'));
    await app.callback(stale.approve,stale.message);
    assert.equal(app.runtime.getSessionLimit(),2);
    await app.update({message_thread_id:waiting.threadId,text:'@FixtureOmpBot Reconnect',entities:[{type:'mention',offset:0,length:14}]});
    const fresh = capacityRequest(app,waiting.threadId);
    assert.notEqual(fresh.approve,stale.approve);
    await app.callback(fresh.approve,fresh.message);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Another waiting task'));
    assert.equal(app.runtime.getSessionLimit(),4);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').map(frame => frame.text),['Running task','Waiting task','Another waiting task']);
  } finally {
    await app.close();
  }
});

test('cancelling a capacity request keeps its initial task pending and cannot later approve', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    await app.callback(request.cancel,request.message);
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.connectionCount,1);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,1);
    assert.equal(app.store.hasPendingInitialTask(app.store.listSessions(botId).find(session => session.name === 'Waiting task')!.id),true);
  } finally {
    await app.close();
  }
});

test('capacity approvals are bound to the original non-forwarded forum message', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    for (const change of [
      {chat:{id:chatId-1,type:'supergroup',is_forum:true}},
      {chat:{id:chatId,type:'private'}},
      {message_id:Number(request.message.message_id)+1},
      {message_thread_id:Number(request.message.message_thread_id)+1},
      {message_thread_id:undefined},
      {from:{id:123,is_bot:true,first_name:'Other bot'}},
      {forward_origin:{type:'hidden_user',sender_user_name:'Forwarded',date:1}},
      {forward_date:1},
    ]) {
      await app.callback(request.approve,{...request.message,...change});
      assert.equal(app.runtime.getSessionLimit(),1);
      assert.equal(app.connectionCount,1);
    }
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),2,'rejected contexts must not authorize or consume the original confirmation');
  } finally {
    await app.close();
  }
});

test('expired capacity approval cannot raise the session limit', async t => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const expired = Date.now()+300001;
    t.mock.method(Date,'now',() => expired);
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.connectionCount,1);
  } finally {
    await app.close();
  }
});

test('a failed current group authorization leaves the request and capacity unchanged', async t => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const lookup = t.mock.method(app.bot.api,'getChat',async () => { throw new Error('Membership lookup unavailable'); });
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.connectionCount,1);
    lookup.mock.restore();
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),2);
  } finally {
    await app.close();
  }
});

for (const readonly of ['file', 'parent'] as const) {
  test(`a capacity confirmation cannot override read-only config ${readonly} permissions`, async () => {
    const app = await waitingForCapacity();
    const target = readonly === 'file' ? app.config.configPath : dirname(app.config.configPath);
    try {
      const request = capacityRequest(app);
      await chmod(target, readonly === 'file' ? 0o400 : 0o500);
      await app.callback(request.approve, request.message);
      assert.equal(app.runtime.getSessionLimit(), 1);
      assert.equal(app.config.omp.maxSessions, 1);
      assert.equal(readConfig(app.config.configPath).omp.maxSessions, 1);
      const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
      assert.equal(app.store.hasPendingInitialTask(waiting.id), true);
    } finally {
      await chmod(target, readonly === 'file' ? 0o600 : 0o700);
      await app.close();
    }
  });
}

test('read-only configuration never offers a runtime-only capacity override', async () => {
  const app = await createSmokeApp({ maxSessions: 1 });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Running task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    await chmod(app.config.configPath, 0o400);
    await app.update({ text: '/new Waiting under read-only configuration' });
    assert.equal(app.runtime.getSessionLimit(), 1);
    assert.equal(app.config.omp.maxSessions, 1);
    assert.equal(app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('capacity:approve:')), false);
  } finally {
    await chmod(app.config.configPath, 0o600);
    await app.close();
  }
});

test('capacity persistence preserves newer CLI configuration rather than overwriting it from memory', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const updated = readConfig(app.config.configPath);
    updated.port = 23456;
    updated.omp.args = [...updated.omp.args, '--new-cli-setting'];
    writeConfig(updated);
    await app.callback(request.approve, request.message);
    const persisted = readConfig(app.config.configPath);
    assert.equal(app.runtime.getSessionLimit(), 2);
    assert.equal(app.config.omp.maxSessions, 2);
    assert.equal(persisted.omp.maxSessions, 2);
    assert.equal(persisted.port, 23456);
    assert.ok(persisted.omp.args.includes('--new-cli-setting'));
    assert.equal(app.config.omp.args.includes('--new-cli-setting'), false, 'other in-memory settings are left to reload reconciliation');
  } finally {
    await app.close();
  }
});

for (const change of ['limit', 'role', 'assignment'] as const) {
  test(`capacity approval respects a newer persisted ${change} change before the watcher catches up`, async () => {
    const app = await waitingForCapacity();
    try {
      const request = capacityRequest(app);
      const updated = readConfig(app.config.configPath);
      const path = Object.keys(updated.instances)[0]!;
      if (change === 'limit') updated.omp.maxSessions = 3;
      else if (change === 'role') app.setCurrentMember({status:'member'});
      else updated.instances[path]!.chats = [];
      writeConfig(updated);
      await app.callback(request.approve, request.message);
      assert.equal(app.runtime.getSessionLimit(), 1);
      assert.equal(app.config.omp.maxSessions, 1);
      assert.deepEqual(readConfig(app.config.configPath), updated);
      const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
      assert.equal(app.store.hasPendingInitialTask(waiting.id), true);
    } finally {
      await app.close();
    }
  });
}
