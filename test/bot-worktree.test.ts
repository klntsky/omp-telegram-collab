import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { TopicSession } from '../shared/contracts.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually, setForumSetting } from './bot-test-helpers.js';

test('General creates an empty topic then passes native branch arguments without skills or quotes', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Warm host'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const existing = app.store.listSessions(botId)[0]!;
    await setForumSetting(app, 2, 0);
    await app.update({text:'/skill_pdf_tools'});
    const calls: Array<{id:string;branch?:string}> = [];
    t.mock.method(app.runtime,'worktree',async (session: TopicSession, branch?: string) => {
      assert.equal(app.store.getSession(session.id)?.threadId,session.threadId);
      calls.push({id:session.id,branch});
      session.runtime = { kind: 'managed' };
      session.cwd = '/fixture/general-worktree';
      return 'Moved to worktree /fixture/general-worktree';
    });
    await app.update({text:'/worktree feature/native',reply_to_message:{message_id:8000,text:'Ignore this quote'}});
    const session = app.store.listSessions(botId).find(session => session.id !== existing.id)!;
    assert.deepEqual(calls,[{id:session.id,branch:'feature/native'}]);
    assert.notEqual(session.threadId,1);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,1);
    assert.equal(app.store.getNewTopicSkill(session.id),'find-skills');
    assert.deepEqual(app.store.getPendingSkills({botId,destination:{kind:'general',chatId},userId:ownerId}),[]);
    await app.update({text:'/p Next task',message_thread_id:session.threadId});
    await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1),{t:'prompt',text:'/skill:find-skills /skill:pdf-tools\n\nNext task'});
    for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId}]) {
      assert.ok((await app.bot.api.getMyCommands({scope})).some(command => command.command === 'worktree'));
    }
  } finally { await app.close(); }
});

test('General worktree waits for group administrator approval', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 1);
    let calls = 0;
    t.mock.method(app.runtime,'worktree',async (session: TopicSession, branch?: string) => {
      calls++;
      assert.equal(branch,'feature/proposed');
      session.runtime = { kind: 'managed' };
      session.cwd = '/fixture/approved';
      return 'Moved to worktree /fixture/approved';
    });
    const proposer = {id:77,is_bot:false,first_name:'Participant',username:'participant'};
    app.setCurrentMember({username:'participant',status:'member'});
    await app.update({text:'/worktree feature/proposed'},proposer);
    assert.equal(calls,0);
    assert.equal(app.store.listSessions(botId).length,0);
    const message = app.messages.findLast(message => JSON.stringify(message.reply_markup)?.includes('prompt:approve:'))!;
    const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(message.reply_markup);
    const callback = markup.inline_keyboard[0]![0]!.callback_data;
    await app.callback(callback,message,proposer);
    assert.equal(calls,0);
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    await app.callback(callback,message);
    assert.equal(calls,1);
    await app.callback(callback,message);
    assert.equal(calls,1);
  } finally { await app.close(); }
});

test('native topic worktree failures preserve session state', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Original'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const before = app.store.listSessions(botId)[0]!;
    const diagnostic = "Worktree creation failed: Branch 'existing' already exists; pick another name.\nNative detail";
    t.mock.method(app.runtime,'worktree',async () => { throw new Error(diagnostic); });
    await app.update({text:'/worktree existing',message_thread_id:before.threadId});
    assert.deepEqual(app.store.getSession(before.id),before);
    assert.equal(app.store.listSessions(botId).length,1);
  } finally { await app.close(); }
});

test('worktree rejects unrelated, detached, and unauthorized topics without invoking OMP', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    let calls = 0;
    t.mock.method(app.runtime,'worktree',async () => { calls++; return ''; });
    await app.update({text:'/worktree',message_thread_id:42});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Source'}});
    const participant = {id:77,is_bot:false,first_name:'Participant',username:'participant'};
    app.setCurrentMember({username:'participant',status:'member'});
    await app.update({text:'/worktree',message_thread_id:42},participant);
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    await app.update({text:'/detach',message_thread_id:42});
    await app.update({text:'/worktree',message_thread_id:42});
    assert.equal(calls,0);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.equal(app.store.listSessions(botId)[0]!.status,'detached');
  } finally { await app.close(); }
});

test('archived topics cannot move their session into a worktree', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Original'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
    let calls = 0;
    t.mock.method(app.runtime,'worktree',async () => { calls++; return ''; });
    await app.update({text:'/worktree',message_thread_id:session.threadId});
    assert.equal(calls,0);
    assert.equal(app.store.getSession(session.id)!.status,'closed');
  } finally { await app.close(); }
});

test('automatic worktree failure does not admit the initial task or consume selected skills', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 5);
    await app.update({text:'/skill_pdf_tools'});
    t.mock.method(app.runtime,'worktree',async () => {
      throw new Error('Native worktree failure\nOriginal diagnostic');
    });
    await app.update({text:'/new Retained task'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    assert.deepEqual(app.store.getPendingSkills({botId,destination:{kind:'general',chatId},userId:ownerId}),['pdf-tools']);
  } finally { await app.close(); }
});

test('automatic worktrees exclude attached sessions and the bot status topic', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Existing host'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    await setForumSetting(app, 5);
    const calls: string[] = [];
    t.mock.method(app.runtime,'worktree',async (session: TopicSession) => {
      calls.push(session.id);
      return '';
    });
    await app.update({text:'/attach existing-host Attached history'});
    const attached = app.store.listSessions(botId).find(session => session.runtime.kind === 'attached')!;
    assert.ok(attached);
    await app.update({message_thread_id:attached.threadId,forum_topic_created:{name:'Attached history'}});
    await app.service.sendStatusNotice(chatId,'Online');
    const threadId = app.store.getBotStatusTopic(botId,chatId)!;
    await app.update({message_thread_id:threadId,forum_topic_created:{name:'Bot status'}});
    assert.deepEqual(calls,[]);
    assert.equal(app.store.listSessions(botId).length,2);
    assert.equal(app.store.getTopic({botId,destination:{kind:'topic',chatId,threadId}}),undefined);
  } finally { await app.close(); }
});
