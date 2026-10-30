import assert from 'node:assert/strict';
import { once, type EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import type { Store } from '../src/store.js';
import { topicDestination } from '../shared/topic-destination.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { setForumSetting } from './bot-test-helpers.js';

interface SeedApp {
  events: EventEmitter;
  store: Store;
  update(message: Record<string,unknown>): Promise<void>;
}
async function seed(app: SeedApp) {
  await app.update({text:'/setup'});
  const accepted = once(app.events,'accepted');
  await app.update({text:'/new Seed'});
  await accepted;
  return app.store.listSessions(botId)[0]!;
}

test('shortcut text immediately submits in explicit mode with pending skills, quote and image', async t => {
  const app = await createSmokeApp();
  const data = Buffer.from('shortcut-image').toString('base64');
  app.mockFiles(t, data);
  try {
    const session = await seed(app);
    await app.update({text:'/setup'});
    await setForumSetting(app, 'Prompt mode', 'Only /p');
    await app.update({text:'/skill_pdf_tools',message_thread_id:session.threadId});
    await app.update({photo:[{file_id:'photo',file_unique_id:'photo',width:10,height:10}],caption:'/skill_find_skills@FixtureOmpBot Explain this\nwith details',message_thread_id:session.threadId,reply_to_message:{message_id:9000,text:'Original\ncontext'}});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{
      t:'prompt',text:'/skill:pdf-tools /skill:find-skills\n\n> Original\n> context\n\nExplain this\nwith details',
      images:[{type:'image',data,mimeType:'image/jpeg'}],
    });
    await app.update({text:'/p Next',message_thread_id:session.threadId});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Next'});
  } finally { await app.close(); }
});

test('General shortcut text creates a topic and deduplicates its default, pending and immediate skill', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 'Default new-topic skill', 'find-skills');
    await app.update({text:'/skill_find_skills'});
    const accepted = once(app.events,'accepted');
    await app.update({text:'/skill_find_skills Do the work',message_id:9001,reply_to_message:{message_id:9000,caption:'Quoted context'}});
    await accepted;
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt'),[{t:'prompt',text:'/skill:find-skills\n\n> Quoted context\n\nDo the work'}]);
    const session = app.store.listSessions(botId)[0]!;
    assert.deepEqual(app.messages.filter(message=>message.message_thread_id===session.threadId && message.forwarded_message_id).map(message=>message.forwarded_message_id),[9000,9001]);
    await app.update({text:'/p Follow up',message_thread_id:session.threadId});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Follow up'});
  } finally { await app.close(); }
});

test('shortcut text respects proposal approval without changing a later pending selection', async () => {
  const app = await createSmokeApp();
  const participant = {id:77,first_name:'Participant',username:'participant',is_bot:false};
  try {
    const session = await seed(app);
    app.setCurrentMember({username:'participant',status:'member'});
    await app.update({text:'/skill_find_skills Ignored',message_thread_id:session.threadId},participant);
    assert.equal(app.accepted.filter(frame=>frame.t==='prompt').length,1);
    assert.deepEqual(app.store.getPendingSkills({botId,destination:topicDestination(chatId,session.threadId),userId:77}),[]);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.update({text:'/setup'});
    await setForumSetting(app, 'User proposals', 'Allow user proposals');
    app.setCurrentMember({username:'participant',status:'member'});
    await app.update({text:'/skill_find_skills Proposed task',message_thread_id:session.threadId},participant);
    const proposal = app.messages.at(-1)!;
    const markup = proposal.reply_markup as {inline_keyboard:Array<Array<{callback_data:string}>>};
    const approve = markup.inline_keyboard.flat().find(button=>button.callback_data.startsWith('prompt:approve:'))!;
    assert.equal(app.accepted.filter(frame=>frame.t==='prompt').length,1);
    await app.update({text:'/skill_pdf_tools',message_thread_id:session.threadId},participant);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(approve.callback_data,proposal);
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'/skill:find-skills\n\nProposed task'});
    assert.deepEqual(app.store.getPendingSkills({botId,destination:topicDestination(chatId,session.threadId),userId:77}),['pdf-tools']);
  } finally { await app.close(); }
});

test('rejected shortcut text preserves pending skills without queuing the immediate skill', async () => {
  const app = await createSmokeApp();
  try {
    const session = await seed(app);
    await app.update({text:'/skill_pdf_tools',message_thread_id:session.threadId});
    app.rejectNextPrompt();
    const rejected = once(app.events,'message');
    await app.update({text:'/skill_find_skills Retry this',message_thread_id:session.threadId});
    await rejected;
    assert.deepEqual(app.store.getPendingSkills({botId,destination:topicDestination(chatId,session.threadId),userId:ownerId}),['pdf-tools']);
    await app.update({text:'/skill_find_skills@AnotherBot Ignore',message_thread_id:session.threadId});
    assert.equal(app.accepted.filter(frame=>frame.t==='prompt').length,1);
    await app.update({text:'/skill_find_skills Retry this',message_thread_id:session.threadId});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'/skill:pdf-tools /skill:find-skills\n\nRetry this'});
    await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
    await app.update({text:'/skill_find_skills Archived task',message_thread_id:session.threadId});
    assert.equal(app.accepted.filter(frame=>frame.t==='prompt').length,2);
  } finally { await app.close(); }
});
