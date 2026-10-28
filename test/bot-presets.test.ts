import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig, writeConfig } from '../src/config.js';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerUsername } from './telegram-data.js';

for (const command of ['/model_preset Fast','/list_model_presets']) {
  test(`${command} requires current instance administration before starting a host`, async t => {
    const app = await createSmokeApp();
    const presets = t.mock.method(app.runtime,'modelPresets');
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Preset authorization'}});
      const session = app.store.listSessions(botId)[0]!;
      app.setCurrentMember({username:'another_admin',status:'administrator'});
      await app.update({text:command,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),false);
      app.setCurrentMember({username:ownerUsername,status:'member'});
      app.setMember(false);
      await app.update({text:command,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),false);
      app.setMember(true);
      const ensure = app.runtime.ensure.bind(app.runtime);
      app.runtime.ensure = async target => {
        const binding = await ensure(target);
        app.setCurrentMember({username:'removed_admin',status:'administrator'});
        return binding;
      };
      await app.update({text:command,message_thread_id:42});
      assert.equal(presets.mock.callCount(),0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });

  test(`${command} rejects unrelated, archived and detached topics`, async t => {
    const app = await createSmokeApp();
    const presets = t.mock.method(app.runtime,'modelPresets');
    const available = t.mock.method(app.runtime,'availableModelPresets');
    try {
      await app.update({text:'/setup'});
      await app.update({text:command,message_thread_id:99});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Archived presets'}});
      await app.update({message_thread_id:42,forum_topic_closed:{}});
      await app.update({text:command,message_thread_id:42});
      await app.update({message_thread_id:42,forum_topic_reopened:{}});
      await app.update({text:'/detach',message_thread_id:42});
      assert.equal(app.store.getTopic({botId,destination:{kind:'topic',chatId,threadId:42}})?.status,'detached');
      await app.update({text:command,message_thread_id:42});
      assert.equal(app.config.instances[Object.keys(app.config.instances)[0]!]!.chats[0]!.default_model_preset,undefined);
      assert.equal(await app.runtime.isRunning(app.store.listSessions(botId)[0]!),false);
      assert.equal(app.connectionCount,0);
      assert.equal(presets.mock.callCount(),0);
      assert.equal(available.mock.callCount(),0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });
}

test('model preset commands reject malformed arguments and ignore foreign or forwarded commands without starting a host', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset boundaries'}});
    for (const message_thread_id of [undefined,1,42]) {
      for (const text of ['/model_preset','/model_preset Fast extra','/model_preset ../Fast','/list_model_presets extra']) {
        await app.update({text,message_thread_id});
        assert.match(String(app.messages.at(-1)?.text),/Usage:/);
      }
    }
    const before = app.messages.length;
    await app.update({text:'/model_preset@AnotherBot Fast',message_thread_id:42});
    await app.update({text:'/list_model_presets',message_thread_id:42,forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}});
    assert.equal(app.messages.length,before);
    assert.equal(await app.runtime.isRunning(app.store.listSessions(botId)[0]!),false);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

for (const message_thread_id of [undefined,1]) {
  test(`General lists presets and persists its default without creating a session (thread ${message_thread_id ?? 'omitted'})`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/list_model_presets',message_thread_id});
      assert.match(String(app.messages.at(-1)?.text),/\bFast\b/);
      assert.match(String(app.messages.at(-1)?.text),/\bSlow\b/);
      await app.update({text:'/model_preset Fast',message_thread_id});
      const path = Object.keys(app.config.instances)[0]!;
      assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Fast');
      assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Fast');
      await app.update({text:'/list_model_presets',message_thread_id});
      assert.match(String(app.messages.at(-1)?.text),/default[^\n]*Fast|Fast[^\n]*default/i);
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.equal(app.connectionCount,0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });
}

for (const command of ['/model_preset Fast','/list_model_presets']) {
  test(`General ${command} requires the current configured instance admin`, async t => {
    const app = await createSmokeApp();
    const available = t.mock.method(app.runtime,'availableModelPresets');
    try {
      await app.update({text:'/setup'});
      const before = readConfig(app.config.configPath);
      for (const member of [
        {username:'another_admin',status:'administrator' as const},
        {username:ownerUsername,is_bot:true,status:'administrator' as const},
      ]) {
        app.setCurrentMember(member);
        await app.update({text:command});
        assert.equal(available.mock.callCount(),0);
        assert.deepEqual(readConfig(app.config.configPath),before);
        assert.doesNotMatch(String(app.messages.at(-1)?.text),/\bSlow\b/);
      }
      app.setCurrentMember({username:ownerUsername,status:'member'});
      app.setMember(false);
      await app.update({text:command});
      assert.deepEqual(readConfig(app.config.configPath),before);
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.equal(app.connectionCount,0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });
}

test('an unknown General preset preserves the saved default and exposes the failure', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/model_preset Slow'});
    const before = readConfig(app.config.configPath);
    await app.update({text:'/model_preset Missing'});
    assert.match(String(app.messages.at(-1)?.text),/Missing/);
    assert.deepEqual(readConfig(app.config.configPath),before);
    const path = Object.keys(app.config.instances)[0]!;
    assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('General rechecks current authorization after loading available presets', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/model_preset Slow'});
    const before = readConfig(app.config.configPath);
    app.runtime.availableModelPresets = async () => {
      app.setCurrentMember({username:'removed_admin',status:'administrator'});
      return ['Fast','Slow'];
    };
    await app.update({text:'/model_preset Fast'});
    assert.match(String(app.messages.at(-1)?.text),/configured instance admin/);
    assert.deepEqual(readConfig(app.config.configPath),before);
    const path = Object.keys(app.config.instances)[0]!;
    assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

for (const change of ['admins','assignment'] as const) {
  test(`General rejects a default change when persisted ${change} change during preset lookup`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/model_preset Slow'});
      const path = Object.keys(app.config.instances)[0]!;
      const updated = readConfig(app.config.configPath);
      if (change === 'admins') updated.instances[path]!.admins = ['another_admin'];
      else updated.instances[path]!.chats = [];
      app.runtime.availableModelPresets = async () => {
        writeConfig(updated);
        return ['Fast','Slow'];
      };
      await app.update({text:'/model_preset Fast'});
      assert.deepEqual(readConfig(app.config.configPath),updated);
      assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('General defaults are isolated by both bot and forum assignment', async () => {
  const app = await createSmokeApp();
  try {
    const path = Object.keys(app.config.instances)[0]!;
    const otherChatId = chatId-1;
    const otherBotId = botId+1;
    app.config.bots.push({id:otherBotId,token:`${otherBotId}:other-fixture-token`,miniAppShortName:'other'});
    app.config.instances[path]!.chats.push(
      {botId,chatId:otherChatId,default_model_preset:'Slow'},
      {botId:otherBotId,chatId,default_model_preset:'Slow'},
    );
    writeConfig(app.config);
    await app.update({text:'/setup'});
    await app.update({text:'/model_preset Fast'});
    assert.deepEqual(readConfig(app.config.configPath).instances[path]!.chats.map(({botId,chatId,default_model_preset}) =>
      ({botId,chatId,default_model_preset})),[
      {botId,chatId,default_model_preset:'Fast'},
      {botId,chatId:otherChatId,default_model_preset:'Slow'},
      {botId:otherBotId,chatId,default_model_preset:'Slow'},
    ]);
    const chat = {id:otherChatId,type:'supergroup',title:'Other forum',is_forum:true};
    await app.update({text:'/setup',chat});
    await app.update({text:'/model_preset Fast',chat});
    await app.update({text:'/model_preset Slow'});
    assert.deepEqual(readConfig(app.config.configPath).instances[path]!.chats.map(({botId,chatId,default_model_preset}) =>
      ({botId,chatId,default_model_preset})),[
      {botId,chatId,default_model_preset:'Slow'},
      {botId,chatId:otherChatId,default_model_preset:'Fast'},
      {botId:otherBotId,chatId,default_model_preset:'Slow'},
    ]);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

test('work-topic preset switches leave the forum default unchanged and General leaves a live host unchanged', async () => {
  const app = await createSmokeApp();
  let activePreset = 'Slow';
  app.runtime.modelPresets = async (_session, name) => {
    if (name) activePreset = name;
    return `Fast\nSlow\nActive preset: ${activePreset}`;
  };
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/model_preset Slow'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Session-only preset'}});
    await app.update({text:'/model_preset Fast',message_thread_id:42});
    const session = app.store.listSessions(botId)[0]!;
    const path = session.instancePath;
    assert.equal(await app.runtime.isRunning(session),true);
    assert.match(String(app.messages.at(-1)?.text),/Active preset: Fast/);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    await app.update({text:'/list_model_presets',message_thread_id:42});
    assert.match(String(app.messages.at(-1)?.text),/Active preset: Fast/);
    await app.update({text:'/model_preset Fast'});
    await app.update({text:'/model_preset Slow'});
    await app.update({text:'/list_model_presets',message_thread_id:42});
    assert.match(String(app.messages.at(-1)?.text),/Active preset: Fast/);
    assert.equal(activePreset,'Fast');
    assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('General persists its preset without overwriting unrelated concurrent configuration edits', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const updated = readConfig(app.config.configPath);
    updated.port = 23456;
    updated.omp.args.push('--new-cli-setting');
    app.runtime.availableModelPresets = async () => {
      writeConfig(updated);
      return ['Fast','Slow'];
    };
    await app.update({text:'/model_preset Fast'});
    const persisted = readConfig(app.config.configPath);
    const path = Object.keys(persisted.instances)[0]!;
    assert.equal(persisted.instances[path]!.chats[0]!.default_model_preset,'Fast');
    assert.equal(persisted.port,23456);
    assert.deepEqual(persisted.omp.args,updated.omp.args);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

for (const readonly of ['file','directory'] as const) {
  test(`General leaves its saved and active default unchanged when the configuration ${readonly} is read-only`, async () => {
    const app = await createSmokeApp();
    const target = readonly === 'file' ? app.config.configPath : dirname(app.config.configPath);
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/model_preset Slow'});
      const before = readConfig(app.config.configPath);
      await chmod(target,readonly === 'file' ? 0o400 : 0o500);
      await app.update({text:'/model_preset Fast'});
      assert.deepEqual(readConfig(app.config.configPath),before);
      const path = Object.keys(app.config.instances)[0]!;
      assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.equal(app.connectionCount,0);
    } finally {
      await chmod(target,readonly === 'file' ? 0o600 : 0o700);
      await app.close();
    }
  });
}
