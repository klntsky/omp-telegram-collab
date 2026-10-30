import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from 'grammy';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, botToken } from './telegram-data.js';

test('/status observes sessions and skill refresh failures without launching hosts or retrying discovery', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Untouched topic'}});
    const ensure = t.mock.method(app.runtime,'ensure',async () => { throw new Error('Status must not launch a host'); });
    const discovery = t.mock.method(app.runtime,'listSkills',async () => { throw new Error('Discovery failed'); });
    await app.service.refreshSkillCatalogs();
    for (const message of [{text:'/status'},{text:'/status',message_thread_id:42},{text:'/status unexpected',message_thread_id:42}]) await app.update(message);
    assert.equal(discovery.mock.callCount(),1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    discovery.mock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return [{name:'restored-skill',description:'Fresh discovery result'}];
    });
    const refreshing = app.service.refreshSkillCatalogs();
    try {
      await entered.promise;
      await app.update({text:'/status'});
    } finally { release.resolve(); await refreshing; }
    await app.update({text:'/status',message_thread_id:42});
    assert.equal(discovery.mock.callCount(),2);
    assert.equal(ensure.mock.callCount(),0);
    assert.equal(app.connectionCount,0);
    assert.deepEqual(app.accepted,[]);
    assert.equal(app.store.listSessions(botId).length,1);
  } finally { await app.close(); }
});

test('file transport failures retain native diagnostics and never submit incomplete tasks', async t => {
  const app = await createSmokeApp({fileTransportFailure:true});
  const logged: unknown[] = [];
  t.mock.method(console,'error',(...args: unknown[]) => { logged.push(...args); });
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Transport failure'}});
    await app.update({message_thread_id:42,caption:'/p Inspect this image',photo:[{file_id:'broken-photo',file_unique_id:'broken-photo',width:100,height:100}]});
    const failure = logged.find((value): value is HttpError => value instanceof HttpError);
    assert.ok(failure);
    assert.ok(failure.error instanceof Error);
    assert.ok(failure.error.message.includes(botToken));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
  } finally { await app.close(); }
});
