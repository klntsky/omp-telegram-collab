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
function configure(app: App, options: string[]) {
  const config = readConfig(app.config.configPath);
  const chat = Object.values(config.instances)[0]!.chats[0]!;
  chat.folder_options = options;
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
      configure(app,['.','other']);
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
    configure(app,['chosen/nested']);
    await app.update({text:'/new task'});
    let message = panel(app);
    assert.equal(existsSync(path),false);
    assert.equal(app.store.listSessions(botId).length,0);
    await app.callback(button(message,'cancel'),message);
    assert.equal(existsSync(path),false);
    await app.update({text:'/new task'});
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
      configure(app,['.','other']);
      await app.update({text:'/new task'});
      const message = panel(app);
      const choice = button(message,'0');
      if (invalidation === 'assignment') {
        const config = readConfig(app.config.configPath);
        Object.values(config.instances)[0]!.chats = [];
        writeConfig(config);
      }
      if (invalidation === 'role') app.setCurrentMember({status:'member'});
      if (invalidation === 'settings') configure(app,['other']);
      if (invalidation === 'expired') { const now = Date.now(); t.mock.method(Date,'now',() => now+300001); }
      if (invalidation === 'actor') await app.callback(choice,message,{id:77,is_bot:false,first_name:'Other'});
      else await app.callback(choice,message);
      assert.equal(app.store.listSessions(botId).length,0);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}


test('non-admin proposals obtain approval before folder or session effects', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,1);
    const root = Object.keys(app.config.instances)[0]!;
    const path = join(root,'approved-folder');
    configure(app,['approved-folder','.']);
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
    configure(app,['.','other']);
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


for (const options of [[],['..']] ) {
  test(`sole effective folder ${JSON.stringify(options)} starts without controls`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const root = Object.keys(app.config.instances)[0]!;
      await mkdir(join(root,'sub'));
      configure(app,options);
      await app.update({text:'/new automatic'});
      assert.equal(panel(app),undefined);
      const sessions = app.store.listSessions(botId);
      assert.equal(sessions.length,1);
      assert.deepEqual(sessions[0]!.runtime,{kind:'managed',cwd:realpathSync(join(root,options[0] ?? '.'))});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'automatic'}]);
    } finally { await app.close(); }
  });
}

test('a selected canonical folder cannot redirect through a replaced symlink before topic creation', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    const selected = join(root,'selected');
    const other = join(root,'other');
    await mkdir(selected);
    await mkdir(other);
    configure(app,['selected','.']);
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
    configure(app,['.','other']);
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    t.mock.method(app.runtime,'modelPresets',async () => 'Fast');
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (method === 'sendMessage' && JSON.stringify(payload).includes('capacity:approve:')) configure(app,[]);
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
    configure(app,['restricted/project','.']);
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
    configure(app,['blocked','.']);
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


test('Add folder appends freshly read configuration and rejects unauthorized replies', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    configure(app,['.']);
    await app.update({text:'/settings'});
    await clickSettings(app,7);
    const input = panel(app,'settings:');
    await clickSettings(app,2,input);
    app.setCurrentMember({status:'member'});
    await app.update({text:'denied',reply_to_message:input});
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,['.']);
    app.setCurrentMember({status:'creator'});
    configure(app,['.','concurrent']);
    await app.update({text:'added',reply_to_message:input});
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,['.','concurrent','added']);
  } finally { await app.close(); }
});

test('any current admin combines multi-folder approval with one existing-folder choice', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,1);
    configure(app,['.','other']);
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
    configure(app,['.','other']);
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
    configure(app,['.','other']);
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
    configure(app,['blocked','.']);
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


for (const transition of ['recovery'] as const) {
  test(`folder transition crossing expiry retires ${transition} controls`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const root = Object.keys(app.config.instances)[0]!;
      const blocked = join(root,'blocked');
      await writeFile(blocked,'not a directory');
      configure(app,['blocked','.']);
      await app.update({text:'/new pending'});
      const selection = panel(app);
      const now = Date.now();
      let expired = false;
      t.mock.method(Date,'now',() => now+(expired ? 300001 : 0));
      app.bot.api.config.use(async (previous,method,payload,signal) => {
        const result = await previous(method,payload,signal);
        if (method === 'editMessageText' && JSON.stringify(payload).includes(':retry')) expired = true;
        return result;
      });
      await app.callback(button(selection,'0'),selection);
      assert.deepEqual(selection.reply_markup,{inline_keyboard:[]});
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.deepEqual(app.createdTopics,[]);
    } finally { await app.close(); }
  });
}

test('removing dot leaves a sole nondefault option and no chooser', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    await mkdir(join(root,'project'));
    configure(app,['.','project']);
    await app.update({text:'/settings'});
    await clickSettings(app,7);
    await clickSettings(app,0);
    assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,['project']);
    await app.update({text:'/new project task'});
    assert.equal(panel(app),undefined);
    assert.deepEqual(app.store.listSessions(botId)[0]!.runtime,{kind:'managed',cwd:realpathSync(join(root,'project'))});
  } finally { await app.close(); }
});

for (const missing of [false,true]) {
  test(`manual singleton stays in its original topic, missing=${missing}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const root = Object.keys(app.config.instances)[0]!;
      const path = join(root,'manual');
      if (!missing) await mkdir(path);
      configure(app,['manual']);
      await app.update({message_thread_id:42,forum_topic_created:{name:'Manual'}});
      if (missing) {
        assert.deepEqual(app.store.listSessions(botId),[]);
        assert.equal(existsSync(path),false);
        const consent = panel(app);
        assert.equal(button(consent,'0'),undefined);
        assert.equal(button(consent,'other'),undefined);
        await app.callback(button(consent,'create'),consent);
      } else assert.equal(panel(app),undefined);
      const sessions = app.store.listSessions(botId);
      assert.equal(sessions.length,1);
      assert.equal(sessions[0]!.threadId,42);
      assert.deepEqual(sessions[0]!.runtime,{kind:'managed',cwd:realpathSync(path)});
      assert.deepEqual(app.createdTopics,[]);
    } finally { await app.close(); }
  });
}

test('singleton proposal requires normal approval then autouses its folder', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,1);
    const root = Object.keys(app.config.instances)[0]!;
    await mkdir(join(root,'approved'));
    configure(app,['approved']);
    app.setCurrentMember({status:'member'});
    await app.update({text:'/new single proposal'},{id:77,is_bot:false,first_name:'Participant'});
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(panel(app),undefined);
    const approval = panel(app,'prompt:approve:');
    assert.ok(approval);
    app.setCurrentMember({status:'creator'});
    await app.callback(callbacks(approval)[0]!,approval);
    assert.equal(panel(app),undefined);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.deepEqual(app.store.listSessions(botId)[0]!.runtime,{kind:'managed',cwd:realpathSync(join(root,'approved'))});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'single proposal'}]);
  } finally { await app.close(); }
});

test('sole folder filesystem failure retains task for retry without another choice', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    const path = join(root,'blocked');
    await writeFile(path,'not a directory');
    configure(app,['blocked']);
    await app.update({text:'/new retained'});
    const recovery = panel(app);
    assert.ok(button(recovery,'retry'));
    assert.equal(button(recovery,'other'),undefined);
    assert.deepEqual(app.store.listSessions(botId),[]);
    await rename(path,join(root,'old-file'));
    await mkdir(path);
    await app.callback(button(recovery,'retry'),recovery);
    assert.equal(app.store.listSessions(botId).length,1);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'retained'}]);
  } finally { await app.close(); }
});

test('automatic folder admission never turns downstream preparation errors into folder retries', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    configure(app,['.']);
    const presets = t.mock.method(app.runtime,'availableModelPresets',async () => { throw new Error('Preset discovery failed'); });
    await app.update({text:'/new /model_preset Fast task'});
    assert.equal(presets.mock.callCount(),1);
    assert.equal(panel(app),undefined);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.createdTopics,[]);
  } finally { await app.close(); }
});

test('manual folder creation rechecks administrator authority before registering the session', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({status:'administrator'});
    await app.update({text:'/setup'});
    const root = Object.keys(app.config.instances)[0]!;
    const path = join(root,'manual');
    configure(app,['manual']);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Manual'}});
    const consent = panel(app);
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      const result = await previous(method,payload,signal);
      if (method === 'editMessageText') app.setCurrentMember({status:'member'});
      return result;
    });
    await app.callback(button(consent,'create'),consent);
    assert.equal(existsSync(path),true);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.createdTopics,[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

for (const mode of ['append','replace'] as const) {
  test(`cancelling folder ${mode} ignores a late reply and permits a fresh edit`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      configure(app,['.']);
      await app.update({text:'/settings'});
      await clickSettings(app,7);
      await clickSettings(app,mode === 'append' ? 2 : 3);
      const input = panel(app,'settings:');
      await app.callback(callbacks(input)[0]!,input);
      await app.update({text:'cancelled-folder',reply_to_message:input});
      assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,['.']);
      await clickSettings(app,mode === 'append' ? 2 : 3);
      await app.update({text:'accepted-folder',reply_to_message:panel(app,'settings:')});
      assert.deepEqual(Object.values(readConfig(app.config.configPath).instances)[0]!.chats[0]!.folder_options,
        mode === 'append' ? ['.','accepted-folder'] : ['accepted-folder']);
      assert.deepEqual(app.store.listSessions(botId),[]);
    } finally { await app.close(); }
  });
}
