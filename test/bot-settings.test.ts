import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { readConfig, writeConfig } from '../src/config.js';
import { botId, chatId, ownerUsername } from './telegram-data.js';
import { clickSettings, setForumSetting, settingsButton } from './bot-test-helpers.js';
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
    for (const label of ['Prompt mode','User proposals','Default new-topic skill','Default model preset','Global admins','Shared capacity','Close']) settingsButton(panel,label);
    await clickSettings(app,'Prompt mode');
    assert.equal(app.messages.at(-1)!.message_id,panel.message_id);
    await clickSettings(app,'Only /p');
    assert.equal(saved(app).chat.all_messages_are_prompts,false);
    await clickSettings(app,'Prompt mode');
    assert.match(String(app.messages.at(-1)!.text),/Only \/p|explicit/i);
    await clickSettings(app,'Back');
    await clickSettings(app,'User proposals');
    await clickSettings(app,'Allow user proposals');
    assert.equal(saved(app).chat.users_can_propose_prompts,true);
    await clickSettings(app,'User proposals');
    await clickSettings(app,'Close');
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
      assert.ok(commands.includes('list_model_presets'));
      assert.ok(!commands.includes('set_default_new_topic_skill'));
      assert.ok(!commands.includes('unset_default_new_topic_skill'));
    }
  } finally { await app.close(); }
});

test('settings callbacks reject unauthorized users, old choices and closed panels', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,'Prompt mode');
    const page = app.messages.at(-1)!;
    const choice = settingsButton(page,'Only /p');
    app.setCurrentMember({username:'other_admin',status:'administrator'});
    await app.callback(choice,page);
    assert.notEqual(saved(app).chat.all_messages_are_prompts,false);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(choice,page);
    assert.equal(saved(app).chat.all_messages_are_prompts,false);
    await clickSettings(app,'Prompt mode');
    await clickSettings(app,'All messages');
    await app.callback(choice,page);
    assert.equal(saved(app).chat.all_messages_are_prompts,true);
    const current = await clickSettings(app,'Prompt mode');
    const old = settingsButton(current,'Only /p');
    await clickSettings(app,'Close');
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
      await clickSettings(app,'Prompt mode');
      const before = saved(app).config;
      await chmod(target,targetKind === 'file' ? 0o400 : 0o500);
      await clickSettings(app,'Only /p');
      assert.deepEqual(saved(app).config,before);
      assert.notEqual(Object.values(app.config.instances)[0]!.chats[0]!.all_messages_are_prompts,false);
      assert.match(app.messages.map(message=>String(message.text)).join('\n'),/read.only|writ|permission|EACCES/i);
    } finally {
      await chmod(target,targetKind === 'file' ? 0o600 : 0o700);
      await app.close();
    }
  });
}

for (const change of ['admins','assignment'] as const) {
  test(`settings cannot overwrite persisted ${change} changes after opening a selection`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await clickSettings(app,'Default model preset');
      const panel = app.messages.at(-1)!;
      const choice = settingsButton(panel,'Fast');
      const updated = saved(app).config;
      const instance = Object.values(updated.instances)[0]!;
      if (change === 'admins') instance.admins = ['another_admin'];
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
    await clickSettings(app,'Default model preset');
    const updated = saved(app).config;
    updated.port = 23456;
    writeConfig(updated);
    await clickSettings(app,'Fast');
    assert.equal(saved(app).chat.default_model_preset,'Fast');
    assert.equal(saved(app).config.port,23456);
    await setForumSetting(app,'Default model preset','Clear default');
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
      await clickSettings(app,catalog === 'skill' ? 'Default new-topic skill' : 'Default model preset');
      const first = app.messages.at(-1)!;
      const markup = first.reply_markup as {inline_keyboard:Array<Array<{callback_data?:string}>>};
      for (const button of markup.inline_keyboard.flat()) if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data)<=64);
      await clickSettings(app,'Next');
      await clickSettings(app,'Previous');
      await clickSettings(app,'Next');
      await clickSettings(app,'Next');
      await clickSettings(app,new RegExp('^Preset18-'));
      assert.equal(catalog === 'skill' ? saved(app).chat.default_new_topic_skill : saved(app).chat.default_model_preset,names[18]);
    } finally { await app.close(); }
  });
}

test('global admin replies are bound to their prompt and never become session prompts', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,'Global admins');
    assert.ok(String(app.messages.at(-1)!.text).includes(ownerUsername));
    await clickSettings(app,'Add global admin');
    const request = app.messages.at(-1)!;
    const participant = {id:77,is_bot:false,first_name:'Participant',username:'participant'};
    await app.update({text:'@intruder',reply_to_message:request},participant);
    assert.equal(saved(app).config.bots[0]!.admins,undefined);
    await app.update({text:'@@invalid',reply_to_message:request});
    assert.equal(saved(app).config.bots[0]!.admins,undefined);
    await app.update({text:'@GrAcE',reply_to_message:request});
    assert.deepEqual(saved(app).config.bots[0]!.admins,['grace']);
    await app.update({text:'@alan',reply_to_message:request});
    assert.deepEqual(saved(app).config.bots[0]!.admins,['grace']);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('shared capacity requires confirmation and does not submit work', async () => {
  const app = await createSmokeApp({maxSessions:2});
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,'Shared capacity');
    await clickSettings(app,'Increase to 4');
    assert.equal(saved(app).config.omp.maxSessions,2);
    assert.equal(app.runtime.getSessionLimit(),2);
    await clickSettings(app,'Confirm increase');
    assert.equal(saved(app).config.omp.maxSessions,4);
    assert.equal(app.runtime.getSessionLimit(),4);
    assert.deepEqual(app.accepted,[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('catalog lookup errors keep original multiline diagnostics', async t => {
  const app = await createSmokeApp();
  const diagnostic = 'Preset catalog failed\noriginal provider diagnostic';
  try {
    await app.update({text:'/setup'});
    t.mock.method(app.runtime,'availableModelPresets',async()=>{ throw new Error(diagnostic); });
    await clickSettings(app,'Default model preset');
    assert.ok(app.messages.some(message=>String(message.text).includes(diagnostic)));
    assert.equal(saved(app).chat.default_model_preset,undefined);
  } finally { await app.close(); }
});

test('settings choices cannot be replayed from another message or destination', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await clickSettings(app,'Prompt mode');
    const page = app.messages.at(-1)!;
    const choice = settingsButton(page,'Only /p');
    await app.callback(choice,{...page,message_id:Number(page.message_id)+1});
    await app.callback(choice,{...page,message_thread_id:42});
    await app.callback(choice,{...page,chat:{id:chatId-1,type:'supergroup',is_forum:true}});
    assert.notEqual(saved(app).chat.all_messages_are_prompts,false);
    await app.callback(choice,page);
    assert.equal(saved(app).chat.all_messages_are_prompts,false);
  } finally { await app.close(); }
});

for (const change of ['admins','assignment','unrelated'] as const) {
  test(`catalog selection re-reads persisted ${change} edits after asynchronous lookup`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await clickSettings(app,'Default model preset');
      const panel = app.messages.at(-1)!;
      const choice = settingsButton(panel,'Fast');
      const updated = saved(app).config;
      const instance = Object.values(updated.instances)[0]!;
      if (change === 'admins') instance.admins = ['another_admin'];
      else if (change === 'assignment') instance.chats = [];
      else updated.port = 23456;
      t.mock.method(app.runtime,'availableModelPresets',async()=>{
        writeConfig(updated);
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

test('a removed catalog choice preserves the saved default and original diagnostic', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app,'Default model preset','Slow');
    await clickSettings(app,'Default model preset');
    const page = app.messages.at(-1)!;
    const choice = settingsButton(page,'Fast');
    t.mock.method(app.runtime,'availableModelPresets',async()=>['Slow']);
    await app.callback(choice,page);
    assert.equal(saved(app).chat.default_model_preset,'Slow');
    assert.ok(app.messages.some(message=>String(message.text).includes('Unknown model preset: Fast')));
  } finally { await app.close(); }
});
