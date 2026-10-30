import { setForumSetting } from './bot-test-helpers.js';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
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
    for (const message_thread_id of [42]) {
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

test('work-topic preset switches leave the forum default unchanged and General leaves a live host unchanged', async () => {
  const app = await createSmokeApp();
  let activePreset = 'Slow';
  app.runtime.modelPresets = async (_session, name) => {
    if (name) activePreset = name;
    return `Fast\nSlow\nActive preset: ${activePreset}`;
  };
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app,'Default model preset','Slow');
    await app.update({message_thread_id:42,forum_topic_created:{name:'Session-only preset'}});
    await app.update({text:'/model_preset Fast',message_thread_id:42});
    const session = app.store.listSessions(botId)[0]!;
    const path = session.instancePath;
    assert.equal(await app.runtime.isRunning(session),true);
    assert.match(String(app.messages.at(-1)?.text),/Active preset: Fast/);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    await app.update({text:'/list_model_presets',message_thread_id:42});
    assert.match(String(app.messages.at(-1)?.text),/Active preset: Fast/);
    await setForumSetting(app,'Default model preset','Fast');
    await setForumSetting(app,'Default model preset','Slow');
    await app.update({text:'/list_model_presets',message_thread_id:42});
    assert.match(String(app.messages.at(-1)?.text),/Active preset: Fast/);
    assert.equal(activePreset,'Fast');
    assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

