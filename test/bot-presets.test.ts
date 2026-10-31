import { setForumSetting, settingsButton } from './bot-test-helpers.js';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerUsername } from './telegram-data.js';

for (const command of ['/model_preset Fast','/model_preset']) {
  test(`${command} requires current native administration before starting a host`, async t => {
    const app = await createSmokeApp();
    const presets = t.mock.method(app.runtime,'modelPresets');
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Preset authorization'}});
      const session = app.store.listSessions(botId)[0]!;
      app.setCurrentMember({username:'another_admin',status:'member'});
      await app.update({text:command,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),false);
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      app.setMember(false);
      await app.update({text:command,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),false);
      app.setMember(true);
      const ensure = app.runtime.ensure.bind(app.runtime);
      app.runtime.ensure = async target => {
        const binding = await ensure(target);
        app.setCurrentMember({username:'removed_admin',status:'member'});
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
      for (const text of ['/model_preset Fast extra','/model_preset ../Fast']) {
        await app.update({text,message_thread_id});
      }
    }
    await app.update({text:'/model_preset@AnotherBot Fast',message_thread_id:42});
    await app.update({text:'/model_preset',message_thread_id:42,forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}});
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
    await setForumSetting(app, 3, 1);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Session-only preset'}});
    await app.update({text:'/model_preset Fast',message_thread_id:42});
    const session = app.store.listSessions(botId)[0]!;
    const path = session.instancePath;
    assert.equal(await app.runtime.isRunning(session),true);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    await app.update({text:'/model_preset',message_thread_id:42});
    await setForumSetting(app, 3, 0);
    await setForumSetting(app, 3, 1);
    await app.update({text:'/model_preset',message_thread_id:42});
    assert.equal(activePreset,'Fast');
    assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('removed preset-list command cannot start or mutate a session and is absent from command menus', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset command cutover'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({text:'/list_model_presets',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),false);
    assert.deepEqual(app.accepted,[]);
    for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId},{type:'chat_administrators' as const,chat_id:chatId}]) {
      const commands = await app.bot.api.getMyCommands({scope});
      assert.equal(commands.some(command => command.command === 'list_model_presets'),false);
      assert.equal(commands.some(command => command.command === 'model_preset'),true);
    }
  } finally { await app.close(); }
});

test('preset browsing, Back, session use and forum defaults have separate effects', async t => {
  const app = await createSmokeApp();
  const switches = t.mock.method(app.runtime, 'modelPresets', async (..._args: Parameters<typeof app.runtime.modelPresets>) => 'applied');
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset panel'}});
    const session = app.store.listSessions(botId)[0]!;
    const panel = () => app.messages.findLast(message =>
      (message.reply_markup as {inline_keyboard?: Array<Array<{callback_data?: string}>>} | undefined)
        ?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('preset:')))!;
    const click = async (index: number) => {
      const message = panel();
      const data = settingsButton(message, index);
      assert.ok(Buffer.byteLength(data) <= 64);
      await app.callback(data, message);
    };
    await app.update({text:'/model_preset',message_thread_id:42});
    await click(0);
    const staleUse = settingsButton(panel(), 0);
    await click(2);
    await app.callback(staleUse, panel());
    assert.equal(switches.mock.callCount(), 0);
    assert.equal(await app.runtime.isRunning(session), false);
    await click(1);
    await click(1);
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, 'Slow');
    assert.equal(await app.runtime.isRunning(session), false);
    await click(2);
    await click(0);
    await click(0);
    assert.equal(switches.mock.callCount(), 1);
    assert.equal(switches.mock.calls[0]!.arguments[1], 'Fast');
    assert.equal(await app.runtime.isRunning(session), true);
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, 'Slow');
    assert.deepEqual(app.accepted, []);
  } finally { await app.close(); }
});

test('preset actions refresh administration after discovery and host startup', async t => {
  const app = await createSmokeApp();
  const switches = t.mock.method(app.runtime, 'modelPresets', async (..._args: Parameters<typeof app.runtime.modelPresets>) => 'applied');
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset write authorization'}});
    const session = app.store.listSessions(botId)[0]!;
    const panel = () => app.messages.findLast(message =>
      (message.reply_markup as {inline_keyboard?: Array<Array<{callback_data?: string}>>} | undefined)
        ?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('preset:')))!;
    await app.update({text:'/model_preset',message_thread_id:42});
    await app.callback(settingsButton(panel(), 0), panel());
    const details = app.runtime.modelPresetDetails.bind(app.runtime);
    app.runtime.modelPresetDetails = async (...args) => {
      const result = await details(...args);
      app.setCurrentMember({username:'removed_admin',status:'member'});
      return result;
    };
    await app.callback(settingsButton(panel(), 1), panel());
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, undefined);
    app.runtime.modelPresetDetails = details;
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    const ensure = app.runtime.ensure.bind(app.runtime);
    app.runtime.ensure = async target => {
      const binding = await ensure(target);
      app.setCurrentMember({username:'removed_admin',status:'member'});
      return binding;
    };
    await app.callback(settingsButton(panel(), 0), panel());
    assert.equal(switches.mock.callCount(), 0);
    assert.deepEqual(app.accepted, []);
  } finally { await app.close(); }
});

test('expired panels, changed sessions and adversarial cross-topic callbacks cannot switch or save presets', async t => {
  const app = await createSmokeApp();
  const switches = t.mock.method(app.runtime, 'modelPresets', async (..._args: Parameters<typeof app.runtime.modelPresets>) => 'applied');
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset lifetime'}});
    const session = app.store.listSessions(botId)[0]!;
    const panel = () => app.messages.findLast(message =>
      (message.reply_markup as {inline_keyboard?: Array<Array<{callback_data?: string}>>} | undefined)
        ?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('preset:')))!;
    await app.update({text:'/model_preset',message_thread_id:42});
    await app.callback(settingsButton(panel(), 0), panel());
    const selected = structuredClone(panel());
    await app.callback(settingsButton(selected, 1), {...selected, message_thread_id:99});
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, undefined);
    const now = Date.now();
    const clock = t.mock.method(Date, 'now', () => now + 31 * 60_000);
    await app.callback(settingsButton(selected, 0), selected);
    clock.mock.restore();
    await app.update({text:'/model_preset',message_thread_id:42});
    await app.callback(settingsButton(panel(), 0), panel());
    const archived = structuredClone(panel());
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    await app.callback(settingsButton(archived, 1), archived);
    assert.equal(switches.mock.callCount(), 0);
    assert.equal(await app.runtime.isRunning(session), false);
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, undefined);
  } finally { await app.close(); }
});

test('preset pagination keeps later choices and detail-page default actions reachable', async () => {
  const app = await createSmokeApp();
  const names = Array.from({length: 17}, (_, index) => `Preset${index}`);
  app.runtime.availableModelPresets = async () => names;
  app.runtime.modelPresetDetails = async () => ({
    modelRoles: Object.fromEntries(Array.from({length: 120}, (_, index) =>
      [`role${index}`, `provider/model-${index}-${'long-model-name'.repeat(5)}#high`])),
    defaultThinkingLevel: 'high',
  });
  const panel = () => app.messages.findLast(message =>
    (message.reply_markup as {inline_keyboard?: Array<Array<{callback_data?: string}>>} | undefined)
      ?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('preset:')))!;
  const click = async (index: number) => {
    const message = panel();
    await app.callback(settingsButton(message, index), message);
  };
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset pages'}});
    await app.update({text:'/model_preset',message_thread_id:42});
    await click(8);
    await click(9);
    await click(0);
    await click(3);
    await click(4);
    await click(1);
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, names[16]);
    assert.equal(await app.runtime.isRunning(session), false);
    await click(2);
    await click(1);
    await click(0);
    await click(1);
    assert.equal(readConfig(app.config.configPath).instances[session.instancePath]!.chats[0]!.default_model_preset, names[8]);
  } finally { await app.close(); }
});
