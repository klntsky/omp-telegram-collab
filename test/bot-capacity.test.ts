import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig, writeConfig } from '../src/config.js';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';
import { capacityRequest, waitingForCapacity } from './bot-capacity-helpers.js';
import type { TopicSession } from '../shared/contracts.js';

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

for (const existing of [false,true]) {
  for (const order of ['worktree-first','preset-first']) {
    test(`composed ${existing ? 'existing' : 'new'} target waits before every ${order} consumer effect`, async t => {
      const app = await createSmokeApp({maxSessions:1,skipStartupRejection:true});
      try {
        await app.update({text:'/setup'});
        await app.update({text:'/new Running'});
        await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
        if (existing) await app.update({message_thread_id:42,forum_topic_created:{name:'Waiting'}});
        t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
        const effects:string[] = [];
        let preset = 'Fallback';
        t.mock.method(app.runtime,'worktree',async (session: TopicSession) => {
          effects.push('worktree');
          await app.runtime.stop(session);
          await assert.rejects(app.runtime.reserveSession('competitor'), /OMP session limit/);
          preset = 'Fallback';
          return 'Worktree switched';
        });
        t.mock.method(app.runtime,'modelPresets',async (_session: TopicSession,name?: string) => {
          effects.push(`preset:${name}`);
          preset = name!;
          return 'Preset applied';
        });
        const before = app.store.listSessions(botId).length;
        const chain = order === 'worktree-first' ? '/worktree /model_preset Fast' : '/model_preset Fast /worktree';
        await app.update({text:`/${existing ? 'p' : 'new'} ${chain} Frozen task`,...(existing ? {message_thread_id:42} : {})});
        assert.deepEqual(effects,[]);
        assert.equal(app.store.listSessions(botId).length,before);
        assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').map(frame => frame.text),['Running']);
        const request = capacityRequest(app);
        await app.callback(request.approve,request.message);
        await eventually(() => app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Frozen task'));
        assert.deepEqual(effects,order === 'worktree-first' ? ['worktree','preset:Fast'] : ['preset:Fast','worktree','preset:Fast']);
        assert.equal(preset,'Fast');
        assert.equal(app.store.listSessions(botId).length,before+(existing ? 0 : 1));
        await app.callback(request.approve,request.message);
        assert.equal(app.accepted.filter(frame => frame.t === 'prompt' && frame.text === 'Frozen task').length,1);
      } finally { await app.close(); }
    });
  }
}

test('cancelled composed capacity admission never creates a target or executes preparations', async t => {
  const app = await createSmokeApp({maxSessions:1,skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Running'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    const prepare = t.mock.method(app.runtime,'modelPresets',async () => 'Applied');
    await app.update({text:'/new /model_preset Fast Never execute'});
    const request = capacityRequest(app);
    await app.callback(request.cancel,request.message);
    await app.callback(request.approve,request.message);
    assert.equal(prepare.mock.callCount(),0);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').map(frame => frame.text),['Running']);
  } finally { await app.close(); }
});

for (const invalidation of ['demotion','generation','termination'] as const) {
  test(`composed capacity approval discards frozen execution after ${invalidation}`, async t => {
    const app = await createSmokeApp({maxSessions:1,skipStartupRejection:true});
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Running'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      await app.update({message_thread_id:42,forum_topic_created:{name:'Waiting'}});
      const session = app.store.listSessions(botId).find(value => value.threadId === 42)!;
      t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
      const prepare = t.mock.method(app.runtime,'modelPresets',async () => 'Applied');
      await app.update({message_thread_id:42,text:'/p /model_preset Fast Must not execute'});
      const request = capacityRequest(app);
      if (invalidation === 'generation') app.store.advanceSessionGeneration(session.id);
      else if (invalidation === 'termination') {
        app.config.terminated = true;
        writeConfig(app.config);
      } else app.setCurrentMember({status:'member'});
      await app.callback(request.approve,request.message);
      assert.equal(prepare.mock.callCount(),0);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').map(frame => frame.text),['Running']);
      assert.equal(app.runtime.getSessionLimit(),1);
    } finally { await app.close(); }
  });
}

test('failed composed preparation releases capacity without replaying or submitting a fallback task', async t => {
  const app = await createSmokeApp({maxSessions:1,skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    const prepare = t.mock.method(app.runtime,'modelPresets',async () => { throw new Error('Native preset rejected'); });
    await app.update({text:'/new /model_preset Fast Must not submit'});
    const failed = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(failed.id),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    await app.runtime.stop(failed);
    const next = await app.runtime.reserveSession('next-target');
    next.release();
    assert.equal(prepare.mock.callCount(),1);
  } finally { await app.close(); }
});

test('composed capacity approval rechecks a distinct approver after sender authorization', async t => {
  const app = await createSmokeApp({maxSessions:1,skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Running'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const prepare = t.mock.method(app.runtime,'modelPresets',async () => 'Applied');
    await app.update({text:'/new /model_preset Fast Must not execute'});
    const request = capacityRequest(app);
    const approver = {id:77,is_bot:false,first_name:'Approver'};
    app.setUserRole(approver,'administrator');
    const getMember = app.bot.api.getChatMember.bind(app.bot.api);
    t.mock.method(app.bot.api,'getChatMember',async (targetChat: number | string, userId: number, signal?: Parameters<typeof getMember>[2]) => {
      if (userId === ownerId) app.setUserRole(approver,'member');
      return getMember(targetChat,userId,signal);
    });
    await app.callback(request.approve,request.message,approver);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(readConfig(app.config.configPath).omp.maxSessions,1);
    assert.equal(prepare.mock.callCount(),0);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Running'}]);
  } finally { await app.close(); }
});
