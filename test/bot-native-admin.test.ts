import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually, setForumSetting } from './bot-test-helpers.js';
import { capacityRequest } from './bot-capacity-helpers.js';

for (const status of ['creator', 'administrator'] as const) {
  test(`username-less native ${status} controls sessions without optional moderation rights`, async () => {
    const app = await createSmokeApp();
    try {
      app.setCurrentMember({status});
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Native authority'}});
      const session = app.store.listSessions(botId)[0]!;
      assert.ok(session);
      assert.equal(await app.service.authorizeSession(session, ownerId + 1), false);
      assert.equal(await app.service.authorizeSession(session, ownerId), true);
      app.setCurrentMember({status:'member'});
      assert.equal(await app.service.authorizeSession(session, ownerId), false);
      await app.update({text:'/settings'});
      assert.match(String(app.messages.at(-1)!.text), /current group owner or administrator/);
    } finally { await app.close(); }
  });
}

test('a member using the owner username does not acquire native authority', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/settings'}, {id:77,is_bot:false,first_name:'Alias',username:ownerUsername});
    assert.match(String(app.messages.at(-1)!.text), /current group owner or administrator/);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('demotion during host startup cancels the recoverable initial task', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const ensure = app.runtime.ensure.bind(app.runtime);
    app.runtime.ensure = async session => {
      const binding = await ensure(session);
      app.setCurrentMember({status:'member'});
      return binding;
    };
    await app.update({text:'/new Rejected after demotion'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
  } finally { await app.close(); }
});

test('deferred proposal admission rechecks its approver rather than treating the proposer as an admin', async () => {
  const app = await createSmokeApp({maxSessions:1});
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app,'User proposals','Allow user proposals');
    await app.update({text:'/new Running task'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const proposer = {id:77,is_bot:false,first_name:'Proposer'};
    await app.update({text:'/new Deferred proposal'},proposer);
    const proposal = app.messages.at(-1)!;
    const markup = proposal.reply_markup as {inline_keyboard:{callback_data:string}[][]};
    await app.callback(markup.inline_keyboard[0]![0]!.callback_data,proposal);
    const pending = app.store.listSessions(botId).find(session => session.name === 'Deferred proposal')!;
    assert.equal(app.store.hasPendingInitialTask(pending.id),true);
    app.setCurrentMember({status:'member'});
    const rescuer = {id:78,is_bot:false,first_name:'Other admin'};
    app.setUserRole(rescuer,'administrator');
    const request = capacityRequest(app,pending.threadId);
    await app.callback(request.approve,request.message,rescuer);
    assert.equal(app.store.hasPendingInitialTask(pending.id),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').map(frame => frame.text),['Running task']);
  } finally { await app.close(); }
});
