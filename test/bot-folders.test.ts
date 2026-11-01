import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { z } from 'zod';
import type { AppConfig } from '../shared/contracts.js';
import { readConfig, writeConfig } from '../src/config.js';
import { botId } from './telegram-data.js';
import { clickSettings, eventually } from './bot-test-helpers.js';

interface App { config: AppConfig; messages: Record<string,unknown>[] }
function configure(app: App, options: string[], required = false) {
  const config = readConfig(app.config.configPath);
  const chat = Object.values(config.instances)[0]!.chats[0]!;
  chat.folder_options = options;
  chat.require_folder_choice = required;
  writeConfig(config);
  Object.assign(Object.values(app.config.instances)[0]!.chats[0]!,chat);
}
function panel(app: App, prefix = 'folder:') {
  return app.messages.findLast(message => JSON.stringify(message.reply_markup)?.includes(prefix))!;
}
function callbacks(message: Record<string,unknown>) {
  const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(message.reply_markup);
  return markup.inline_keyboard.flat().map(button => button.callback_data);
}
function button(message: Record<string,unknown>, suffix: string) {
  return callbacks(message).find(data => data.endsWith(`:${suffix}`))!;
}

for (const command of ['/new task','/p task']) {
  test(`${command} defers all session side effects and starts once in chosen cwd`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const root = Object.keys(app.config.instances)[0]!;
      configure(app,[root]);
      await app.update({text:command});
      assert.equal(app.store.listSessions(botId).length,0);
      assert.equal(app.connectionCount,0);
      const message = panel(app);
      const choice = button(message,'0');
      await app.callback(choice,message);
      await app.callback(choice,message);
      const sessions = app.store.listSessions(botId);
      assert.equal(sessions.length,1);
      assert.equal(sessions[0]!.instancePath,root);
      assert.deepEqual(sessions[0]!.runtime,{kind:'managed',cwd:realpathSync(root)});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,1);
      await app.update({text:'/p existing',message_thread_id:sessions[0]!.threadId});
      await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
      assert.equal(app.store.listSessions(botId).length,1);
    } finally { await app.close(); }
  });
}

test('missing folder requires explicit confirmation and cancellation never creates it', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const path = join(Object.keys(app.config.instances)[0]!,'chosen','nested');
    configure(app,[path],true);
    await app.update({text:'/new task'});
    let message = panel(app);
    await app.callback(button(message,'0'),message);
    assert.equal(existsSync(path),false);
    assert.equal(app.store.listSessions(botId).length,0);
    message = panel(app);
    await app.callback(button(message,'cancel'),message);
    assert.equal(existsSync(path),false);
    await app.update({text:'/new task'});
    message = panel(app);
    const oldChoice = button(message,'0');
    await app.callback(oldChoice,message);
    await app.callback(oldChoice,message);
    message = panel(app);
    const create = button(message,'create');
    await app.callback(create,message);
    await app.callback(create,message);
    assert.equal(existsSync(path),true);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.deepEqual(app.store.listSessions(botId)[0]!.runtime,{kind:'managed',cwd:realpathSync(path)});
  } finally { await app.close(); }
});

for (const invalidation of ['role','settings','assignment','expired','actor'] as const) {
  test(`folder selection rejects ${invalidation} without session mutation`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const root = Object.keys(app.config.instances)[0]!;
      configure(app,[root],true);
      await app.update({text:'/new task'});
      const message = panel(app);
      const choice = button(message,'0');
      if (invalidation === 'assignment') {
        const config = readConfig(app.config.configPath);
        Object.values(config.instances)[0]!.chats = [];
        writeConfig(config);
      }
      if (invalidation === 'role') app.setCurrentMember({status:'member'});
      if (invalidation === 'settings') configure(app,[root],false);
      if (invalidation === 'expired') { const now = Date.now(); t.mock.method(Date,'now',() => now+300001); }
      if (invalidation === 'actor') await app.callback(choice,message,{id:77,is_bot:false,first_name:'Other'});
      else await app.callback(choice,message);
      assert.equal(app.store.listSessions(botId).length,0);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('required empty configuration and manual topics never start a default session', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    configure(app,[],true);
    await app.update({text:'/new task'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Manual'}});
    await app.update({text:'/p task',message_thread_id:42});
    assert.equal(app.store.listSessions(botId).length,0);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('folder settings use explicit message-bound replacement, removal and toggle', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,7);
    let message = panel(app,'settings:');
    await clickSettings(app,3,message);
    const root = Object.keys(app.config.instances)[0]!;
    await app.update({text:`${root}\n${root}/missing`,reply_to_message:message});
    let config = readConfig(app.config.configPath);
    assert.deepEqual(Object.values(config.instances)[0]!.chats[0]!.folder_options,[root,`${root}/missing`]);
    await clickSettings(app,0);
    config = readConfig(app.config.configPath);
    assert.equal(Object.values(config.instances)[0]!.chats[0]!.require_folder_choice,true);
    await clickSettings(app,1);
    config = readConfig(app.config.configPath);
    assert.deepEqual(Object.values(config.instances)[0]!.chats[0]!.folder_options,[`${root}/missing`]);
    message = panel(app,'settings:');
    await clickSettings(app,2,message);
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('non-admin proposals obtain approval before folder or session effects', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,1);
    const root = Object.keys(app.config.instances)[0]!;
    const path = join(root,'approved-folder');
    configure(app,[path],true);
    const proposer = {id:77,is_bot:false,first_name:'Participant',username:'participant'};
    app.setCurrentMember({username:'participant',status:'member'});
    await app.update({text:'/new proposed'},proposer);
    assert.equal(existsSync(path),false);
    assert.equal(panel(app,'prompt:approve:'),undefined);
    let selection = panel(app);
    const choose = button(selection,'0');
    assert.equal(app.store.listSessions(botId).length,0);
    app.setCurrentMember({status:'creator'});
    await app.callback(choose,selection);
    await app.callback(choose,selection);
    selection = panel(app);
    await app.callback(button(selection,'create'),selection);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.equal(existsSync(path),true);
    await app.callback(choose,selection);
    assert.equal(app.store.listSessions(botId).length,1);
  } finally { await app.close(); }
});

test('folder selection precedes command capacity reservation and survives approval retry', async t => {
  const app = await createSmokeApp({maxSessions:1});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new running'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[root],true);
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    const presets = t.mock.method(app.runtime,'modelPresets',async () => 'Fast');
    await app.update({text:'/new /model_preset Fast waiting'});
    assert.equal(app.store.listSessions(botId).length,1);
    assert.equal(presets.mock.callCount(),0);
    assert.equal(panel(app,'capacity:'),undefined);
    const selection = panel(app);
    await app.callback(button(selection,'0'),selection);
    const capacity = panel(app,'capacity:');
    assert.ok(capacity);
    assert.equal(app.store.listSessions(botId).length,1);
    const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(capacity.reply_markup);
    await app.callback(markup.inline_keyboard[0]![0]!.callback_data,capacity);
    const session = app.store.listSessions(botId).find(session => session.name.includes('waiting'))!;
    assert.ok(session);
    assert.equal(session.instancePath,root);
    assert.deepEqual(session.runtime,{kind:'managed',cwd:realpathSync(root)});
    assert.equal(presets.mock.callCount(),1);
    await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
  } finally { await app.close(); }
});

test('folder lists are paginated without creating a session until a visible choice is accepted', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,Array.from({length:24},(_,index) => join(root,String(index))),true);
    await app.update({text:'/new task'});
    let selection = panel(app);
    let markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(selection.reply_markup);
    assert.ok(markup.inline_keyboard.length <= 11);
    await app.callback(button(selection,'page8'),selection);
    selection = panel(app);
    markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(selection.reply_markup);
    assert.ok(markup.inline_keyboard.length <= 11);
    assert.ok(button(selection,'8'));
    assert.equal(app.store.listSessions(botId).length,0);
    await app.callback(button(selection,'cancel'),selection);
    assert.equal(app.store.listSessions(botId).length,0);
  } finally { await app.close(); }
});

test('optional choices can explicitly retain forum default and unconfigured forums need no picker', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new unchanged'});
    assert.equal(panel(app),undefined);
    const original = app.store.listSessions(botId)[0]!;
    assert.deepEqual(original.runtime,{kind:'managed'});
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[join(root,'unused')]);
    await app.update({text:'/new default'});
    const selection = panel(app);
    await app.callback(button(selection,'default'),selection);
    assert.equal(existsSync(join(root,'unused')),false);
    const session = app.store.listSessions(botId).find(session => session.id !== original.id)!;
    assert.equal(session.instancePath,root);
    assert.deepEqual(session.runtime,{kind:'managed',cwd:realpathSync(root)});
  } finally { await app.close(); }
});

test('a selected canonical folder cannot redirect through a replaced symlink before topic creation', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    const selected = join(root,'selected');
    const other = join(root,'other');
    await mkdir(selected);
    await mkdir(other);
    configure(app,[selected],true);
    t.mock.method(app.runtime,'availableModelPresets',async () => {
      await rename(selected,join(root,'previous'));
      await symlink(other,selected);
      return ['Fast'];
    });
    await app.update({text:'/new /model_preset Fast task'});
    const selection = panel(app);
    await app.callback(button(selection,'0'),selection);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.createdTopics,[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('folder settings changed during capacity confirmation cannot authorize an old selection', async t => {
  const app = await createSmokeApp({maxSessions:1});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new running'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[root],true);
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    t.mock.method(app.runtime,'modelPresets',async () => 'Fast');
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (method === 'sendMessage' && JSON.stringify(payload).includes('capacity:approve:')) configure(app,[],true);
      return previous(method,payload,signal);
    });
    await app.update({text:'/new /model_preset Fast pending'});
    const selection = panel(app);
    await app.callback(button(selection,'0'),selection);
    const capacity = panel(app,'capacity:');
    const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(capacity.reply_markup);
    await app.callback(markup.inline_keyboard[0]![0]!.callback_data,capacity);
    assert.equal(readConfig(app.config.configPath).omp.maxSessions,1);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'running'}]);
  } finally { await app.close(); }
});

test('folder creation rejects denied access and permissions revoked after confirmation', {skip:process.getuid?.() === 0}, async () => {
  const app = await createSmokeApp();
  const parent = join(Object.keys(app.config.instances)[0]!,'restricted');
  try {
    await app.update({text:'/setup'});
    await mkdir(parent);
    const selected = join(parent,'project');
    configure(app,[selected],true);
    await chmod(parent,0o500);
    await app.update({text:'/new denied'});
    let selection = panel(app);
    await app.callback(button(selection,'0'),selection);
    assert.equal(existsSync(selected),false);
    assert.deepEqual(app.store.listSessions(botId),[]);
    await chmod(parent,0o700);
    selection = panel(app);
    await app.callback(button(selection,'retry'),selection);
    const confirmation = panel(app);
    const create = button(confirmation,'create');
    await chmod(parent,0o500);
    await app.callback(create,confirmation);
    assert.equal(existsSync(selected),false);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.createdTopics,[]);
    assert.equal(app.connectionCount,0);
    const recovery = panel(app);
    const retry = button(recovery,'retry');
    await chmod(parent,0o700);
    await app.callback(create,confirmation);
    assert.equal(existsSync(selected),false);
    await app.callback(retry,recovery);
    assert.equal(existsSync(selected),true);
    assert.equal(app.store.listSessions(botId).length,1);
  } finally {
    if (existsSync(parent)) await chmod(parent,0o700);
    await app.close();
  }
});

test('failed pre-admission selection retains task, rotates callbacks and supports retry', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    const blocked = join(root,'blocked');
    await writeFile(blocked,'not a directory');
    configure(app,[blocked,root],true);
    await app.update({text:'/new original task'});
    const selection = panel(app);
    const choose = button(selection,'0');
    await app.callback(choose,selection);
    const failed = panel(app);
    const retry = button(failed,'retry');
    assert.notEqual(retry.split(':')[1],choose.split(':')[1]);
    await app.callback(choose,selection);
    assert.deepEqual(app.store.listSessions(botId),[]);
    await app.callback(retry,failed);
    const retried = panel(app);
    assert.notEqual(button(retried,'retry'),retry);
    await app.callback(button(retried,'other'),retried);
    const next = panel(app);
    await app.callback(button(next,'1'),next);
    assert.equal(app.store.listSessions(botId).length,1);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'original task'}]);
  } finally { await app.close(); }
});

test('empty required folders retain task through exact-message append setup', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[],true);
    await app.update({text:'/new bootstrap task'});
    let selection = panel(app);
    await app.callback(button(selection,'add'),selection);
    selection = panel(app);
    await app.update({text:root,reply_to_message:selection});
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,[root]);
    assert.deepEqual(app.store.listSessions(botId),[]);
    selection = panel(app);
    await app.callback(button(selection,'0'),selection);
    assert.equal(app.store.listSessions(botId).length,1);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'bootstrap task'}]);
  } finally { await app.close(); }
});

test('Add folder appends freshly read configuration and rejects unauthorized replies', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[root]);
    await app.update({text:'/settings'});
    await clickSettings(app,7);
    const input = panel(app,'settings:');
    await clickSettings(app,3,input);
    app.setCurrentMember({status:'member'});
    await app.update({text:`${root}/denied`,reply_to_message:input});
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,[root]);
    app.setCurrentMember({status:'creator'});
    configure(app,[root,`${root}/concurrent`]);
    await app.update({text:`${root}/added`,reply_to_message:input});
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,[root,`${root}/concurrent`,`${root}/added`]);
  } finally { await app.close(); }
});

test('any current admin combines required-folder approval with one existing-folder choice', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,1);
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[root],true);
    app.setCurrentMember({status:'member'});
    await app.update({text:'/new combined task'},{id:77,is_bot:false,first_name:'Participant'});
    const selection = panel(app);
    const choose = button(selection,'0');
    app.setCurrentMember({status:'creator'});
    const admin = {id:88,is_bot:false,first_name:'Another admin'};
    app.setUserRole(admin,'administrator');
    await app.callback(choose,selection,admin);
    await app.callback(choose,selection,admin);
    assert.equal(app.store.listSessions(botId).length,1);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'combined task'}]);
  } finally { await app.close(); }
});

test('expired known folder requests retire controls and cannot replay', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    configure(app,[Object.keys(app.config.instances)[0]!],true);
    await app.update({text:'/new expired task'});
    const selection = panel(app);
    const choose = button(selection,'0');
    const now = Date.now();
    t.mock.method(Date,'now',() => now+300001);
    await app.callback(choose,selection);
    assert.deepEqual(selection.reply_markup,{inline_keyboard:[]});
    await app.callback(choose,selection);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.createdTopics,[]);
  } finally { await app.close(); }
});

test('folder waiting freezes pending skills, quoted context and downloaded media', async t => {
  const app = await createSmokeApp();
  const data = Buffer.from('folder-image').toString('base64');
  app.mockFiles(t,data);
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[root],true);
    await app.update({text:'/skill_find_skills'});
    await app.update({photo:[{file_id:'photo',file_unique_id:'photo',width:10,height:10}],caption:'/new Explain',
      reply_to_message:{message_id:9900,text:'Original context'}});
    const selection = panel(app);
    await app.update({text:'/skill_pdf_tools'});
    await app.callback(button(selection,'0'),selection);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{
      t:'prompt',text:'/skill:find-skills\n\n> Original context\n\nExplain',
      images:[{type:'image',data,mimeType:'image/jpeg'}],
    }]);
    assert.deepEqual(app.fileRequests,['photo']);
  } finally { await app.close(); }
});

test('unknown folder tokens never replay tasks or erase unrelated bot controls', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/settings'});
    const settings = panel(app,'settings:');
    const before = callbacks(settings);
    await app.callback('folder:AAAAAAAAAAAAAAAAAAAAAA:0',settings);
    assert.deepEqual(callbacks(settings),before);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.createdTopics,[]);
    // Accessible callback messages include their current inline keyboard.
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L5565-L5569
    const token = 'BBBBBBBBBBBBBBBBBBBBBB';
    await app.bot.api.editMessageReplyMarkup(Number(settings.chat_id),Number(settings.message_id),{
      reply_markup:{inline_keyboard:[[{text:'Old folder',callback_data:`folder:${token}:0`}]]},
    });
    await app.callback(`folder:${token}:0`,settings);
    assert.deepEqual(settings.reply_markup,{inline_keyboard:[]});
    assert.deepEqual(app.store.listSessions(botId),[]);
  } finally { await app.close(); }
});

test('queued stale callback snapshots cannot clear replacement folder controls', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    const blocked = join(root,'blocked');
    await writeFile(blocked,'not a directory');
    configure(app,[blocked],true);
    await app.update({text:'/new pending'});
    const selection = panel(app);
    const snapshot = structuredClone(selection);
    const choose = button(selection,'0');
    await app.callback(choose,selection);
    const recovery = panel(app);
    const controls = callbacks(recovery);
    await app.callback(choose,snapshot);
    assert.deepEqual(callbacks(recovery),controls);
    assert.deepEqual(app.store.listSessions(botId),[]);
  } finally { await app.close(); }
});

test('bootstrap append preserves configuration changed during proposer authorization', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,1);
    const root = Object.keys(app.config.instances)[0]!;
    configure(app,[],true);
    const proposer = {id:77,is_bot:false,first_name:'Participant'};
    await app.update({text:'/new pending'},proposer);
    let selection = panel(app);
    await app.callback(button(selection,'add'),selection);
    selection = panel(app);
    let changed = false;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (!changed && method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === proposer.id) {
        changed = true;
        const config = readConfig(app.config.configPath);
        config.port = 34567;
        Object.values(config.instances)[0]!.chats[0]!.folder_options = [`${root}/concurrent`];
        writeConfig(config);
      }
      return previous(method,payload,signal);
    });
    await app.update({text:`${root}/added`,reply_to_message:selection});
    const saved = readConfig(app.config.configPath);
    assert.equal(saved.port,34567);
    assert.deepEqual(Object.values(saved.instances)[0]!.chats[0]!.folder_options,[`${root}/concurrent`,`${root}/added`]);
    assert.deepEqual(app.store.listSessions(botId),[]);
  } finally { await app.close(); }
});

for (const transition of ['recovery','bootstrap'] as const) {
  test(`folder transition crossing expiry retires ${transition} controls`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const root = Object.keys(app.config.instances)[0]!;
      const blocked = join(root,'blocked');
      await writeFile(blocked,'not a directory');
      configure(app,transition === 'recovery' ? [blocked] : [],true);
      await app.update({text:'/new pending'});
      let selection = panel(app);
      if (transition === 'bootstrap') {
        await app.callback(button(selection,'add'),selection);
        selection = panel(app);
      }
      const now = Date.now();
      let expired = false;
      t.mock.method(Date,'now',() => now+(expired ? 300001 : 0));
      app.bot.api.config.use(async (previous,method,payload,signal) => {
        const result = await previous(method,payload,signal);
        if (method === 'editMessageText' && JSON.stringify(payload).includes(transition === 'recovery' ? ':retry' : ':0')) expired = true;
        return result;
      });
      if (transition === 'recovery') await app.callback(button(selection,'0'),selection);
      else await app.update({text:root,reply_to_message:selection});
      assert.deepEqual(selection.reply_markup,{inline_keyboard:[]});
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.deepEqual(app.createdTopics,[]);
    } finally { await app.close(); }
  });
}
