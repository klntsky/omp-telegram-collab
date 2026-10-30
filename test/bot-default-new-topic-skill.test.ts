import assert from 'node:assert/strict';
import { once, type EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { readConfig } from '../src/config.js';
import { botId, chatId, ownerUsername } from './telegram-data.js';
import type { AppConfig } from '../shared/contracts.js';
import type { Store } from '../src/store.js';
import { setForumSetting } from './bot-test-helpers.js';

interface DefaultSkillApp {
  config: AppConfig;
  store: Store;
  events: EventEmitter;
  update(message: Record<string,unknown>): Promise<void>;
}

async function seed(app: DefaultSkillApp) {
  await app.update({text:'/setup'});
  const accepted = once(app.events,'accepted');
  await app.update({text:'/new Existing topic'});
  await accepted;
  return app.store.listSessions(botId)[0]!;
}
function savedDefault(app: DefaultSkillApp) {
  return Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.default_new_topic_skill;
}
const participant = {id:77,is_bot:false,first_name:'Participant',username:'participant'};

test('settings preserve exact default skill identities and allow clearing', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    t.mock.method(app.runtime,'listSkills',async () => [
      {name:'Case/Exact-Name',description:'Exact canonical identity'},
      {name:'clear',description:'Valid skill named clear'},
    ]);
    await setForumSetting(app, 2, 0);
    assert.equal(savedDefault(app),'Case/Exact-Name');
    await setForumSetting(app, 2, 1);
    assert.equal(savedDefault(app),'clear');
    await setForumSetting(app, 2, -3);
    assert.equal(savedDefault(app),undefined);
  } finally { await app.close(); }
});

for (const command of ['/new','/p']) {
  test(`General ${command} merges the default with explicit skills once and preserves quoted images`, async t => {
    const app = await createSmokeApp();
    const data = Buffer.from('image').toString('base64');
    app.mockFiles(t, data);
    try {
      const existing = await seed(app);
      await setForumSetting(app, 2, 0);
      await app.update({text:'/skill_find_skills'});
      await app.update({text:'/skill_pdf_tools'});
      await app.update({photo:[{file_id:'photo',file_unique_id:'photo',width:10,height:10}],caption:`${command} Explain`,reply_to_message:{message_id:9900,text:'Context'}});
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{
        t:'prompt',text:'/skill:find-skills /skill:pdf-tools\n\n> Context\n\nExplain',images:[{type:'image',data,mimeType:'image/jpeg'}],
      });
      const created = app.store.listSessions(botId).find(session=>session.id!==existing.id)!;
      await app.update({text:'/p Follow up',message_thread_id:created.threadId});
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Follow up'});
      await app.update({text:'/p Unchanged existing topic',message_thread_id:existing.threadId});
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Unchanged existing topic'});
    } finally { await app.close(); }
  });
}

test('manual topics snapshot the default, deduplicate selections and restore it after a known startup rejection', async () => {
  const app = await createSmokeApp();
  try {
    await seed(app);
    await setForumSetting(app, 2, 0);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Manual topic'}});
    const manual = app.store.getTopic({botId,destination:{kind:'topic',chatId,threadId:42}})!;
    await setForumSetting(app, 2, 1);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Duplicate update'}});
    assert.equal(app.store.getNewTopicSkill(manual.id),'find-skills');
    await app.update({text:'/skill_find_skills',message_thread_id:42});
    app.rejectNextPrompt();
    const rejection = once(app.events,'message');
    await app.update({text:'/p First attempt',message_thread_id:42});
    await rejection;
    assert.equal(app.store.getNewTopicSkill(manual.id),'find-skills');
    await app.update({text:'/p Accepted first task',message_thread_id:42});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'/skill:find-skills\n\nAccepted first task'});
    assert.equal(app.store.getNewTopicSkill(manual.id),undefined);
    await app.update({text:'Follow up',message_thread_id:42});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Follow up'});
  } finally { await app.close(); }
});

for (const manual of [false,true]) {
  test(`${manual ? 'manual topic' : 'General initial-task'} proposals freeze their default independently of later configuration`, async () => {
    const app = await createSmokeApp();
    try {
      await seed(app);
      await setForumSetting(app, 2, 0);
      if (manual) await app.update({message_thread_id:42,forum_topic_created:{name:'Proposal topic'}});
      await app.update({text:'/setup'});
      await setForumSetting(app, 1, 0);
      app.setCurrentMember({username:'participant',status:'member'});
      await app.update({text:'/p Proposed task',...(manual ? {message_thread_id:42} : {})},participant);
      const proposal = app.messages.at(-1)!;
      const markup = proposal.reply_markup as {inline_keyboard:Array<Array<{callback_data:string}>>};
      const approve = markup.inline_keyboard.flat().find(button=>button.callback_data.startsWith('prompt:approve:'))!;
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      await setForumSetting(app, 2, 1);
      await app.callback(approve.callback_data,proposal);
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'/skill:find-skills\n\nProposed task'});
      const topic = manual ? app.store.getTopic({botId,destination:{kind:'topic',chatId,threadId:42}})! : app.store.listSessions(botId).find(session=>session.name.includes('Proposed task'))!;
      await app.update({text:'/p Follow up',message_thread_id:topic.threadId});
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Follow up'});
    } finally { await app.close(); }
  });
}

test('attached sessions do not inherit new-topic defaults', async () => {
  const app = await createSmokeApp();
  try {
    await seed(app);
    await setForumSetting(app, 2, 0);
    await app.update({text:'/attach existing-host Attached history'});
    const attached = app.store.listSessions(botId).find(session=>session.runtime.kind==='attached')!;
    await app.update({text:'/p Continue history',message_thread_id:attached.threadId});
    assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Continue history'});
  } finally { await app.close(); }
});

