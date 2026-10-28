import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { readConfig, writeConfig } from '../src/config.js';
import { botId, ownerId, ownerUsername } from './telegram-data.js';

const terminated = 'The service got terminated, only admin can resume it (remove terminated: true from the config)';

test('/terminate requires an instance admin, kills all sessions, blocks commands and gateway, and resumes from config removal', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    for (const threadId of [42,43]) await app.update({message_thread_id:threadId,forum_topic_created:{name:`Topic ${threadId}`}});
    const sessions = app.store.listSessions(botId);
    for (const session of sessions) await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    app.setCurrentMember({username:'outsider',status:'administrator'});
    await app.update({text:'/terminate'}, {id:ownerId+1,first_name:'Other',username:'outsider',is_bot:false});
    assert.equal(readConfig(app.config.configPath).terminated,undefined);
    for (const session of sessions) assert.equal(await app.runtime.isRunning(session),true);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.update({text:'/terminate'});
    assert.equal(readConfig(app.config.configPath).terminated,true);
    assert.equal(app.messages.at(-1)?.text,terminated);
    for (const session of sessions) assert.equal(await app.runtime.isRunning(session),false);
    const accepted = [...app.accepted];
    for (const text of ['/new Forbidden','/help','/setup','/unknown','/terminate','plain prompt']) {
      await app.update({text,message_thread_id:42});
      assert.equal(app.messages.at(-1)?.text,terminated);
    }
    assert.deepEqual(app.accepted,accepted);
    assert.equal(app.store.listSessions(botId).length,2);
    const session = sessions[0]!;
    const response = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id)})});
    assert.notEqual(response.status,200);
    assert.match(await response.text(),/The service got terminated/);
    const config = readConfig(app.config.configPath);
    delete config.terminated;
    writeConfig(config);
    await app.update({text:'/help'});
    assert.match(String(app.messages.at(-1)?.text),/\/terminate/);
    await app.update({text:'/p Resumed work',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),true);
  } finally { await app.close(); }
});

test('/terminate preempts blocked command admission and fences its eventual completion', async t => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pending: Promise<void> | undefined;
  try {
    await app.update({text:'/setup'});
    const ensure = app.runtime.ensure.bind(app.runtime);
    t.mock.method(app.runtime,'ensure',async (session: Parameters<typeof ensure>[0]) => {
      const binding = await ensure(session);
      entered.resolve();
      await release.promise;
      return binding;
    });
    pending = app.update({text:'/new Blocked startup'});
    await entered.promise;
    await app.update({text:'/terminate'});
    assert.equal(readConfig(app.config.configPath).terminated,true);
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(await app.runtime.isRunning(session),false);
    release.resolve();
    await pending;
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
  } finally {
    release.resolve();
    await pending;
    await app.close();
  }
});
