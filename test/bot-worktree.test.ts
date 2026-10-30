import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

for (const threadId of [1, 42]) {
  test(`/worktree from ${threadId === 1 ? 'General' : 'a topic'} creates a separate managed session and forwards quotes`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (threadId !== 1) await app.update({message_thread_id:threadId,forum_topic_created:{name:'Source'}});
      const calls: string[] = [];
      t.mock.method(app.runtime,'createWorktree',async (path: string) => { calls.push(path); return '/fixture/worktrees/new'; });
      await app.update({message_id:8100,text:'/worktree Explain',message_thread_id:threadId,
        reply_to_message:{message_id:8000,text:'Context'}});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId).find(session => session.runtime.kind === 'managed' && session.runtime.worktreePath)!;
      assert.ok(session);
      assert.notEqual(session.threadId,threadId);
      assert.equal(session.instancePath,Object.keys(app.config.instances)[0]);
      assert.deepEqual(calls,[session.instancePath]);
      assert.deepEqual(session.runtime,{kind:'managed',worktreePath:'/fixture/worktrees/new'});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'> Context\n\nExplain'}]);
      assert.deepEqual(app.messages.filter(message => message.message_thread_id === session.threadId && message.forwarded_message_id)
        .map(message => message.forwarded_message_id),[8000,8100]);
      for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId}]) {
        assert.ok((await app.bot.api.getMyCommands({scope})).some(command => command.command === 'worktree'));
      }
    } finally { await app.close(); }
  });

  test(`empty /worktree from ${threadId} transfers selections and snapshots the forum default`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Warm host'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      if (threadId !== 1) await app.update({message_thread_id:threadId,forum_topic_created:{name:'Source'}});
      await app.update({text:'/set_default_new_topic_skill find-skills'});
      const source = {botId,destination:threadId === 1 ? {kind:'general' as const,chatId} : {kind:'topic' as const,chatId,threadId},userId:ownerId};
      await app.update({text:'/skill_pdf_tools',message_thread_id:threadId});
      await app.update({text:'/worktree',message_thread_id:threadId});
      const session = app.store.listSessions(botId).find(session => session.runtime.kind === 'managed' && session.runtime.worktreePath)!;
      assert.ok(session);
      assert.equal(app.store.hasPendingInitialTask(session.id),false);
      assert.equal(app.store.getNewTopicSkill(session.id),'find-skills');
      assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,1);
      assert.equal(app.messages.some(message => String(message.text).includes('what should we work on?')),false);
      await app.update({text:'/p Next task',message_thread_id:session.threadId});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1),{t:'prompt',text:'/skill:find-skills /skill:pdf-tools\n\nNext task'});
      assert.deepEqual(app.store.getPendingSkills(source),[]);
    } finally { await app.close(); }
  });
}

for (const task of ['', ' Proposed task']) {
  test(`/worktree${task} does not allocate until instance-admin approval`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.callback('setup:proposals:true',app.messages.at(-1)!);
      let creations = 0;
      t.mock.method(app.runtime,'createWorktree',async () => { creations++; return '/fixture/approved'; });
      const proposer = {id:77,is_bot:false,first_name:'Participant',username:'participant'};
      app.setCurrentMember({username:'participant',status:'administrator'});
      await app.update({text:`/worktree${task}`},proposer);
      assert.equal(creations,0);
      assert.equal(app.store.listSessions(botId).length,0);
      const message = app.messages.findLast(message => JSON.stringify(message.reply_markup)?.includes('prompt:approve:'))!;
      const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(message.reply_markup);
      const callback = markup.inline_keyboard[0]![0]!.callback_data;
      await app.callback(callback,message,proposer);
      assert.equal(creations,0);
      app.setCurrentMember({username:ownerUsername,status:'member'});
      await app.callback(callback,message);
      assert.equal(creations,1);
      assert.deepEqual(app.store.listSessions(botId)[0]!.runtime,{kind:'managed',worktreePath:'/fixture/approved'});
      await app.callback(callback,message);
      assert.equal(creations,1);
    } finally { await app.close(); }
  });
}

test('Git worktree failure preserves diagnostics and selected skills without creating a session', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/skill_pdf_tools'});
    const diagnostic = 'git worktree add failed\nfatal: not a git repository';
    t.mock.method(app.runtime,'createWorktree',async () => { throw new Error(diagnostic); });
    await app.update({text:'/worktree Task'});
    assert.equal(app.store.listSessions(botId).length,0);
    assert.ok(app.messages.some(message => String(message.text).includes(diagnostic)));
    assert.equal(app.store.getPendingSkills({botId,destination:{kind:'general',chatId},userId:ownerId}).length,1);
  } finally { await app.close(); }
});

test('/worktree remains available in detached topics and rejects non-admin creation when proposals are disabled', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Detached source'}});
    await app.update({text:'/detach',message_thread_id:42});
    let creations = 0;
    t.mock.method(app.runtime,'createWorktree',async () => { creations++; return '/fixture/detached-source'; });
    const participant = {id:77,is_bot:false,first_name:'Participant',username:'participant'};
    app.setCurrentMember({username:'participant',status:'administrator'});
    await app.update({text:'/worktree',message_thread_id:42},participant);
    assert.equal(creations,0);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.update({text:'/worktree',message_thread_id:42});
    assert.equal(creations,1);
    const sessions = app.store.listSessions(botId);
    assert.equal(sessions.find(session => session.threadId === 42)!.status,'detached');
    assert.ok(sessions.some(session => session.threadId !== 42 && session.runtime.kind === 'managed' &&
      session.runtime.worktreePath === '/fixture/detached-source'));
  } finally { await app.close(); }
});
