import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { readConfig, writeConfig } from '../src/config.js';
import { botId, chatId } from './telegram-data.js';
import { clickSettings, eventually, setForumSetting, settingsButton } from './bot-test-helpers.js';
import type { AppConfig } from '../shared/contracts.js';

function saved(app: { config: AppConfig }) {
  const config = readConfig(app.config.configPath);
  const instance = Object.values(config.instances).find(value => value.chats.some(chat => chat.botId === botId && chat.chatId === chatId))!;
  return { config, instance, chat: instance.chats.find(chat => chat.botId === botId && chat.chatId === chatId)! };
}

test('setup opens current settings and navigation edits one panel with Back and Close', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    const panel = app.messages.at(-1)!;
    await clickSettings(app, 0);
    assert.equal(app.messages.at(-1)!.message_id,panel.message_id);
    await clickSettings(app, 1);
    assert.equal(saved(app).chat.all_messages_are_prompts,false);
    await clickSettings(app, 0);
    assert.equal(saved(app).chat.all_messages_are_prompts,true);
    await clickSettings(app, -2);
    await clickSettings(app, 1);
    await clickSettings(app, 0);
    assert.equal(saved(app).chat.users_can_propose_prompts,true);
    await clickSettings(app, 1);
    assert.equal(saved(app).chat.users_can_propose_prompts,false);
    await clickSettings(app, -2);
    await clickSettings(app, -1);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('settings command menus remove superseded preference commands but retain session operations', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId}]) {
      const commands = (await app.bot.api.getMyCommands({scope})).map(command=>command.command);
      assert.ok(commands.includes('settings'));
      assert.ok(commands.includes('model_preset'));
      assert.ok(!commands.includes('list_model_presets'));
      assert.ok(!commands.includes('set_default_new_topic_skill'));
      assert.ok(!commands.includes('unset_default_new_topic_skill'));
    }
  } finally { await app.close(); }
});

test('settings callbacks reject unauthorized users, old choices and closed panels', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app, 0);
    const page = app.messages.at(-1)!;
    const choice = settingsButton(page, 1);
    app.setCurrentMember({username:'other_admin',status:'member'});
    await app.callback(choice,page);
    assert.notEqual(saved(app).chat.all_messages_are_prompts,false);
    app.setCurrentMember({status:'creator'});
    await app.callback(choice,page);
    assert.equal(saved(app).chat.all_messages_are_prompts,false);
    await clickSettings(app, 0);
    await clickSettings(app, 0);
    await app.callback(choice,page);
    assert.equal(saved(app).chat.all_messages_are_prompts,true);
    const current = await clickSettings(app, 0);
    const old = settingsButton(current, 1);
    await clickSettings(app, -1);
    await app.callback(old,current);
    assert.equal(saved(app).chat.all_messages_are_prompts,true);
  } finally { await app.close(); }
});

for (const targetKind of ['file','directory'] as const) {
  test(`settings retain saved and in-memory values when configuration ${targetKind} is read-only`, async () => {
    const app = await createSmokeApp();
    const target = targetKind === 'file' ? app.config.configPath : dirname(app.config.configPath);
    try {
      await app.update({text:'/setup'});
      await clickSettings(app, 0);
      const before = saved(app).config;
      await chmod(target,targetKind === 'file' ? 0o400 : 0o500);
      await clickSettings(app, 1);
      assert.deepEqual(saved(app).config,before);
      assert.notEqual(Object.values(app.config.instances)[0]!.chats[0]!.all_messages_are_prompts,false);
    } finally {
      await chmod(target,targetKind === 'file' ? 0o600 : 0o700);
      await app.close();
    }
  });
}

for (const change of ['role','assignment'] as const) {
  test(`settings cannot overwrite persisted ${change} changes after opening a selection`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await clickSettings(app, 3);
      const panel = app.messages.at(-1)!;
      const choice = settingsButton(panel, 0);
      const updated = saved(app).config;
      const instance = Object.values(updated.instances)[0]!;
      if (change === 'role') app.setCurrentMember({status:'member'});
      else instance.chats = [];
      writeConfig(updated);
      await app.callback(choice,panel);
      assert.deepEqual(readConfig(app.config.configPath),updated);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('default model selection and clearing preserve unrelated concurrent configuration', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app, 3);
    const updated = saved(app).config;
    updated.port = 23456;
    writeConfig(updated);
    await clickSettings(app, 0);
    assert.equal(saved(app).chat.default_model_preset,'Fast');
    assert.equal(saved(app).config.port,23456);
    await setForumSetting(app, 3, -3);
    assert.equal(saved(app).chat.default_model_preset,undefined);
    assert.equal(saved(app).config.port,23456);
  } finally { await app.close(); }
});

for (const catalog of ['skill','preset'] as const) {
  test(`${catalog} catalogs paginate and persist long exact names through short callback tokens`, async t => {
    const app = await createSmokeApp();
    const names = Array.from({length:19},(_,index)=>`Preset${String(index).padStart(2,'0')}-${'long-catalog-name-'.repeat(8)}${index}`);
    try {
      if (catalog === 'skill') t.mock.method(app.runtime,'listSkills',async()=>names.map(name=>({name,description:'Catalog entry'})));
      else t.mock.method(app.runtime,'availableModelPresets',async()=>names);
      await app.update({text:'/setup'});
      await clickSettings(app,catalog === 'skill' ? 2 : 3);
      const first = app.messages.at(-1)!;
      const markup = first.reply_markup as {inline_keyboard:Array<Array<{callback_data?:string}>>};
      for (const button of markup.inline_keyboard.flat()) if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data)<=64);
      await clickSettings(app,9);
      await clickSettings(app,9);
      await clickSettings(app,9);
      await clickSettings(app,10);
      await clickSettings(app,1);
      assert.equal(catalog === 'skill' ? saved(app).chat.default_new_topic_skill : saved(app).chat.default_model_preset,names[17]);
      await clickSettings(app,2);
      assert.equal(catalog === 'skill' ? saved(app).chat.default_new_topic_skill : saved(app).chat.default_model_preset,names[18]);
    } finally { await app.close(); }
  });
}

for (const explicit of [false,true]) {
  test(`settings replies follow normal prompt routing in ${explicit ? 'explicit' : 'all-message'} mode`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (explicit) await setForumSetting(app,0,1);
      await app.update({text:'/settings'});
      const panel = app.messages.at(-1)!;
      const before = saved(app).config;
      await app.update({text:'Implement this reply',reply_to_message:panel});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      assert.equal(app.store.listSessions(botId).length,1);
      const prompts = app.accepted.filter(frame => frame.t === 'prompt');
      assert.equal(prompts.length,1);
      assert.ok(prompts[0]!.text.endsWith('Implement this reply'));
      assert.deepEqual(saved(app).config,before);
    } finally { await app.close(); }
  });
}

for (const [limit,choice,target] of [[8,0,7],[8,1,9],[8,2,1],[8,3,18],[8,4,16],[Number.MAX_SAFE_INTEGER-1,1,Number.MAX_SAFE_INTEGER]] as const) {
  test(`live session capacity button ${choice} proposes ${target} before confirmation`, async () => {
    const app = await createSmokeApp({maxSessions:limit});
    try {
      await app.update({text:'/setup'});
      await clickSettings(app, 4);
      await clickSettings(app, choice);
      assert.equal(saved(app).config.omp.maxSessions,limit);
      assert.equal(app.runtime.getSessionLimit(),limit);
      await clickSettings(app, 0);
      assert.equal(saved(app).config.omp.maxSessions,target);
      assert.equal(app.runtime.getSessionLimit(),target);
      assert.deepEqual(app.accepted,[]);
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

for (const [limit,choice] of [[1,0],[1,2],[Number.MAX_SAFE_INTEGER,1],[Number.MAX_SAFE_INTEGER,3],[Number.MAX_SAFE_INTEGER,4]] as const) {
  test(`capacity button ${choice} preserves valid bounds at ${limit}`, async () => {
    const app = await createSmokeApp({maxSessions:limit});
    try {
      await app.update({text:'/setup'});
      await clickSettings(app, 4);
      await clickSettings(app, choice);
      assert.equal(saved(app).config.omp.maxSessions,limit);
      assert.equal(app.runtime.getSessionLimit(),limit);
      assert.deepEqual(app.accepted,[]);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('canceling a capacity proposal leaves the live and persisted limits unchanged', async () => {
  const app = await createSmokeApp({maxSessions:8});
  try {
    await app.update({text:'/setup'});
    await clickSettings(app, 4);
    await clickSettings(app, 4);
    await clickSettings(app, -2);
    assert.equal(saved(app).config.omp.maxSessions,8);
    assert.equal(app.runtime.getSessionLimit(),8);
    assert.deepEqual(app.accepted,[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

for (const change of ['role','limit'] as const) {
  test(`capacity confirmation rejects a stale ${change} without mutating runtime`, async () => {
    const app = await createSmokeApp({maxSessions:8});
    try {
      await app.update({text:'/setup'});
      await clickSettings(app, 4);
      await clickSettings(app, 1);
      const confirmation = app.messages.at(-1)!;
      const choice = settingsButton(confirmation,0);
      const updated = saved(app).config;
      if (change === 'role') app.setCurrentMember({status:'member'});
      else {
        updated.omp.maxSessions = 12;
        writeConfig(updated);
      }
      await app.callback(choice,confirmation);
      assert.deepEqual(readConfig(app.config.configPath),updated);
      assert.equal(app.runtime.getSessionLimit(),8);
      assert.deepEqual(app.accepted,[]);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('catalog lookup failure preserves the saved default and permits retry', async t => {
  const app = await createSmokeApp();
  const diagnostic = 'Preset catalog failed\noriginal provider diagnostic';
  try {
    await app.update({text:'/setup'});
    const panel = app.messages.at(-1)!;
    const lookup = t.mock.method(app.runtime,'availableModelPresets',async()=>{ throw new Error(diagnostic); });
    await clickSettings(app, 3);
    assert.equal(saved(app).chat.default_model_preset,undefined);
    lookup.mock.restore();
    await clickSettings(app, 3, panel);
    await clickSettings(app, 0, panel);
    assert.equal(saved(app).chat.default_model_preset,'Fast');
    await clickSettings(app, -1, panel);
  } finally { await app.close(); }
});

test('settings choices cannot be replayed from another message or destination', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app, 0);
    const page = app.messages.at(-1)!;
    const choice = settingsButton(page, 1);
    await app.callback(choice,{...page,message_id:Number(page.message_id)+1});
    await app.callback(choice,{...page,message_thread_id:42});
    await app.callback(choice,{...page,chat:{id:chatId-1,type:'supergroup',is_forum:true}});
    assert.notEqual(saved(app).chat.all_messages_are_prompts,false);
    await app.callback(choice,page);
    assert.equal(saved(app).chat.all_messages_are_prompts,false);
  } finally { await app.close(); }
});

for (const change of ['role','assignment','unrelated'] as const) {
  test(`catalog selection re-reads persisted ${change} edits after asynchronous lookup`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await clickSettings(app, 3);
      const panel = app.messages.at(-1)!;
      const choice = settingsButton(panel, 0);
      const updated = saved(app).config;
      const instance = Object.values(updated.instances)[0]!;
      if (change === 'assignment') instance.chats = [];
      else if (change === 'unrelated') updated.port = 23456;
      let changed = false;
      t.mock.method(app.runtime,'availableModelPresets',async()=>{
        if (!changed) {
          changed = true;
          if (change === 'role') app.setCurrentMember({status:'member'});
          writeConfig(updated);
        }
        return ['Fast','Slow'];
      });
      await app.callback(choice,panel);
      const persisted = readConfig(app.config.configPath);
      if (change === 'unrelated') {
        assert.equal(persisted.port,23456);
        assert.equal(saved(app).chat.default_model_preset,'Fast');
      } else assert.deepEqual(persisted,updated);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('a removed catalog choice preserves the saved default', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 3, 1);
    const page = app.messages.at(-1)!;
    const choice = settingsButton(page, 0);
    t.mock.method(app.runtime,'availableModelPresets',async()=>['Slow']);
    await app.callback(choice,page);
    assert.equal(saved(app).chat.default_model_preset,'Slow');
  } finally { await app.close(); }
});

test('panels from a previous service instance explain expiration without accepting forwarded controls', async () => {
  const before = await createSmokeApp();
  let panel: Record<string,unknown>;
  let choice: string;
  try {
    await before.update({text:'/setup'});
    panel = structuredClone(before.messages.at(-1)!);
    choice = settingsButton(panel, 0);
  } finally { await before.close(); }
  const after = await createSmokeApp();
  const answers: string[] = [];
  after.bot.api.config.use(async (previous,method,payload,signal) => {
    if (method === 'answerCallbackQuery' && 'text' in payload && typeof payload.text === 'string') answers.push(payload.text);
    return previous(method,payload,signal);
  });
  try {
    await after.update({text:'/setup'});
    await after.callback(choice!,{...panel!,forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}});
    assert.deepEqual(answers,[]);
    await after.callback(choice!,panel!);
    assert.equal(answers.length,1);
    assert.deepEqual(after.store.listSessions(botId),[]);
  } finally { await after.close(); }
});
