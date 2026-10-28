import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readConfig, writeConfig } from '../src/config.js';
import { test } from 'node:test';
import WebSocket from 'ws';
import { z } from 'zod';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected state transition did not occur');
    await delay(20);
  }
}

function capacityRequest(app: {messages:Record<string, unknown>[]}, threadId?: number) {
  const message = app.messages.findLast(message => (threadId === undefined || message.message_thread_id === threadId) &&
    JSON.stringify(message.reply_markup)?.includes('capacity:approve:'));
  assert.ok(message,'a capacity confirmation must be sent in the waiting topic');
  const markup = message.reply_markup;
  assert.ok(markup && typeof markup === 'object' && 'inline_keyboard' in markup && Array.isArray(markup.inline_keyboard));
  const buttons = markup.inline_keyboard[0];
  assert.ok(Array.isArray(buttons) && typeof buttons[0]?.callback_data === 'string' && typeof buttons[1]?.callback_data === 'string');
  return {message,approve:String(buttons[0].callback_data),cancel:String(buttons[1].callback_data)};
}

async function waitingForCapacity() {
  const app = await createSmokeApp({maxSessions:1});
  await app.update({text:'/setup'});
  await app.update({text:'/new Running task'});
  await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
  await app.update({text:'/new Waiting task'});
  return app;
}

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
      assert.equal(app.store.getTopic({botId,chatId,threadId:42})?.status,'detached');
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

for (const [source, threadId, text] of [
  ['/new in General', undefined, '/new Create a session'],
  ['/new in a topic', 42, '/new Create another session'],
  ['interactive /new', 42, 'Create an interactive session'],
  ['/attach', undefined, '/attach local-instance Attached session'],
] as const) {
  test(`${source} replies to the creating message with the topic link before host startup`, async () => {
    const app = await createSmokeApp();
    let messagesAtStartup: Record<string, unknown>[] = [];
    app.runtime.ensure = async () => {
      messagesAtStartup = [...app.messages];
      throw new Error('Host startup failed');
    };
    try {
      await app.update({ text: '/setup' });
      let replyTo: Record<string, unknown> | undefined;
      if (source === 'interactive /new') {
        await app.update({ text: '/new', message_thread_id: threadId });
        replyTo = app.messages.at(-1)!;
      }
      await app.update({
        message_id: 7001, text, message_thread_id: threadId,
        ...(replyTo ? { reply_to_message: replyTo } : {}),
      });
      const session = app.store.listSessions(botId)[0]!;
      const reply = messagesAtStartup.find(message =>
        (message.reply_parameters as { message_id?: number } | undefined)?.message_id === 7001);
      assert.ok(reply, 'the creator can navigate to the topic even if its host fails to start');
      assert.equal(reply.chat_id, chatId);
      assert.equal(reply.message_thread_id, threadId);
      assert.equal(reply.text, `Topic created: https://t.me/c/1234567890/${session.threadId}`);
    } finally {
      await app.close();
    }
  });
}

for (const [source, message] of [
  ['manual topic', { message_thread_id: 42, forum_topic_created: { name: 'Manual session', icon_color: 7322096 } }],
  ['/new', { text: '/new Start a session' }],
  ['/attach', { text: '/attach local-instance Attached session' }],
] as const) {
  test(`${source} pins the session button before host startup, even when startup fails`, async () => {
    const app = await createSmokeApp();
    let pinsAtStartup: Record<string, unknown>[] = [];
    app.runtime.ensure = async () => {
      pinsAtStartup = [...app.pins];
      throw new Error('Host startup failed');
    };
    try {
      await app.update({ text: '/setup' });
      await app.update(message);
      const session = app.store.listSessions(botId)[0]!;
      if (source === 'manual topic') {
        assert.equal(pinsAtStartup.length,0,'creating an empty topic must not launch a host');
        await app.update({ message_thread_id: session.threadId, text: '@FixtureOmpBot Start coding', entities: [{ type: 'mention', offset: 0, length: 14 }] });
      }
      const announcement = app.messages.find(value => value.message_thread_id === session.threadId && value.reply_markup);
      assert.ok(announcement, 'the session entry remains available when the host cannot start');
      assert.deepEqual(announcement.reply_markup, {
        inline_keyboard: [[{ text: 'Open Session', url: `https://t.me/FixtureOmpBot/app?startapp=s_${session.id}` }]],
      });
      assert.deepEqual(pinsAtStartup, [{ chat_id: session.chatId, message_id: announcement.message_id, disable_notification: true }]);
      const before = app.messages.length;
      await app.update({ message_thread_id: session.threadId, forum_topic_created: { name: session.name, icon_color: 7322096 } });
      assert.equal(app.messages.length, before, 'duplicate service events do not repost the session entry');
      assert.deepEqual(app.pins, pinsAtStartup);
    } finally {
      await app.close();
    }
  });
}

for (const failure of [
  new Error('Host 🚫 could not start: <socket> & `token`\nECONNREFUSED 127.0.0.1:3000'),
  'Local service unavailable',
]) {
  test(`operation failures expose literal code-block details for ${typeof failure} rejections`, async () => {
    const app = await createSmokeApp();
    app.runtime.ensure = async () => { throw failure; };
    try {
      await app.update({ text: '/setup' });
      await app.update({ text: '/new Start a session' });
      const reply = app.messages.at(-1)!;
      const details = failure instanceof Error ? failure.message : failure;
      const text = String(reply.text);
      const entities = reply.entities as { type: string; offset: number; length: number }[];
      assert.ok(text.endsWith(details));
      assert.equal(reply.parse_mode, undefined);
      assert.deepEqual(entities, [{ type: 'pre', offset: text.length - details.length, length: details.length }]);
      assert.equal(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length), details);
    } finally {
      await app.close();
    }
  });
}

test('enrollment requires permission to pin the session entry', async () => {
  const app = await createSmokeApp({ botCanPinMessages: false });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Cannot pin this session' });
    assert.equal(app.store.isEnrolled(botId, chatId), false);
    assert.deepEqual(app.store.listSessions(botId), []);
  } finally {
    await app.close();
  }
});

test('anonymous-admin topic closure persists the gateway archive restriction', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Authentication' });
    const session = app.store.listSessions(botId)[0]!;
    await app.update({ message_thread_id: session.threadId, forum_topic_closed: {}, sender_chat: { id: session.chatId, type: 'supergroup', title: 'Fixture project' } }, { id: 1087968824, first_name: 'Group', is_bot: true });
    assert.equal(app.store.getSession(session.id)?.status, 'closed');
    const before = app.accepted.length;
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const data = await response.json() as { ticket: string };
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${data.ticket}`, { origin: app.config.publicUrl });
    const frames: { t: string; readOnly?: boolean }[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk'));
    assert.equal(frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'prompt', text: 'Cannot run in an archived topic' }));
    await closed;
    assert.equal(app.accepted.length, before);
  } finally {
    await app.close();
  }
});

test('another participant starting work does not cancel an explicitly rejected initial task', async () => {
  const app = await createSmokeApp({ competingStartAfterRejection: true });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Preserve this task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Preserve this task' }]);
  } finally {
    await app.close();
  }
});

test('Telegram rate limits recover without shutting down the bot service', async () => {
  const app = await createSmokeApp({ pollingTransientFailure: true });
  const polled = once(app.events, 'poll');
  const running = app.service.start();
  try {
    const outcome = await Promise.race([polled.then(() => 'recovered'), running.then(() => 'stopped', () => 'failed')]);
    assert.equal(outcome, 'recovered');
  } finally {
    await app.close();
    await running.catch(() => undefined);
  }
});

test('a relay disconnect restores mirroring without replaying the admitted prompt', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Finish the task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const before = app.connectionCount;
    app.disconnect();
    const delivered = once(app.events, 'message');
    app.appendEntry({ type: 'message', id: 'missed-output', parentId: null, timestamp: new Date().toISOString(), message: {
      role: 'assistant', content: [{ type: 'text', text: 'Recovered output' }], model: 'fixture', timestamp: Date.now() + 10,
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    } });
    await eventually(() => app.connectionCount > before);
    await delivered;
    assert.equal(app.messages.at(-1)?.text, 'Recovered output');
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Finish the task' }]);
  } finally {
    await app.close();
  }
});

test('agent replies retain their triggering Telegram message across chunks and later prompts', async () => {
  const app = await createSmokeApp();
  const answer = (id: number, text: string) => app.emit({ t: 'entry', entry: {
    type: 'message', id: `answer-${id}`, parentId: null, timestamp: new Date(id).toISOString(),
    message: {
      role: 'assistant', content: [{ type: 'text', text }], model: 'fixture', timestamp: id,
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    },
  } });
  try {
    await app.update({ message_id: 2000, text: '/setup' });
    await app.update({ message_id: 2001, text: '/new Initial request' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    answer(1, 'Initial answer');
    await eventually(() => app.messages.some(message => message.text === 'Initial answer'));
    assert.deepEqual(app.messages.at(-1)?.reply_parameters, { message_id: 2001, allow_sending_without_reply: true });

    await app.update({ message_id: 2002, message_thread_id: session.threadId, text: '@FixtureOmpBot First follow-up', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    const before = app.messages.length;
    answer(2, 'a'.repeat(8001));
    await app.update({ message_id: 2003, message_thread_id: session.threadId, text: '@FixtureOmpBot Second follow-up', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    await eventually(() => app.messages.length >= before + 3);
    const chunks = app.messages.slice(before);
    assert.deepEqual(chunks.map(message => message.text), ['a'.repeat(4000), 'a'.repeat(4000), 'a']);
    assert.ok(chunks.every(message => message.message_thread_id === session.threadId));
    assert.deepEqual(chunks.map(message => message.reply_parameters), Array.from({ length: 3 }, () => ({ message_id: 2002, allow_sending_without_reply: true })));

    const formattedStart = app.messages.length;
    answer(5, `**${'😀<&'.repeat(2001)}**`);
    await eventually(() => app.messages.length >= formattedStart + 3);
    const formatted = app.messages.slice(formattedStart);
    assert.deepEqual(formatted.map(message => message.text), [
      `<b>${'😀&lt;&amp;'.repeat(1000)}</b>`,
      `<b>${'😀&lt;&amp;'.repeat(1000)}</b>`,
      '<b>😀&lt;&amp;</b>',
    ]);
    assert.ok(formatted.every(message => message.parse_mode === 'HTML' && message.message_thread_id === session.threadId));
    assert.deepEqual(formatted.map(message => message.reply_parameters), Array.from({ length: 3 }, () => ({ message_id: 2003, allow_sending_without_reply: true })));

    await app.update({ message_id: 2004, message_thread_id: session.threadId, text: 'Plain-text follow-up' });
    answer(3, 'Plain-text follow-up answer');
    await eventually(() => app.messages.some(message => message.text === 'Plain-text follow-up answer'));
    assert.deepEqual(app.messages.at(-1)?.reply_parameters, { message_id: 2004, allow_sending_without_reply: true });

    app.emit({ t: 'entry', entry: {
      type: 'custom_message', id: 'web-prompt', parentId: null, timestamp: new Date(4).toISOString(),
      customType: 'collab-prompt', content: 'Instruction from the Mini App', details: { from: 'Web participant' }, display: true,
    } });
    answer(4, 'Mini App answer');
    await eventually(() => app.messages.some(message => message.text === 'Mini App answer'));
    assert.equal(app.messages.at(-1)?.reply_parameters, undefined);
  } finally {
    await app.close();
  }
});

test('bot receipt is immediate, while only admitted instructions get agent receipt reactions', async () => {
  const app = await createSmokeApp();
  const admitted = () => app.reactions.filter(reaction => JSON.stringify(reaction.reaction).includes('🤝'));
  try {
    await app.update({text:'/setup'});
    await app.update({message_id:3001,text:'/new Initial instruction'});
    await eventually(() => admitted().length === 1);
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_id:3002,message_thread_id:session.threadId,text:'@FixtureOmpBot Follow-up',entities:[{type:'mention',offset:0,length:14}]});
    await app.update({message_id:3003,message_thread_id:session.threadId,text:'Reply instruction',reply_to_message:{message_id:4000,from:{id:botId,is_bot:true,first_name:'OMP'}}});
    await eventually(() => admitted().length === 3);
    await app.update({message_id:3004,message_thread_id:session.threadId,text:'Ordinary message received by the bot'});
    await eventually(() => admitted().some(reaction => reaction.message_id === 3004));
    app.rejectNextPrompt();
    const rejected = once(app.events,'message');
    await app.update({message_id:3005,message_thread_id:session.threadId,text:'@FixtureOmpBot Rejected instruction',entities:[{type:'mention',offset:0,length:14}]});
    await rejected;
    await app.update({message_id:3006,message_thread_id:session.threadId,text:'@FixtureOmpBot Accepted instruction',entities:[{type:'mention',offset:0,length:14}]});
    await eventually(() => admitted().some(reaction => reaction.message_id === 3006));
    assert.deepEqual(app.reactions.filter(reaction => JSON.stringify(reaction.reaction).includes('👀')).map(reaction => reaction.message_id),[3001,3002,3003,3004,3005,3006]);
    assert.deepEqual(admitted().map(reaction => reaction.message_id),[3001,3002,3003,3004,3006]);
    for (const id of [3001,3002,3003,3004,3006]) {
      assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === id).map(reaction => reaction.reaction),[
        [{type:'emoji',emoji:'👀'}],[{type:'emoji',emoji:'🤝'}],
      ]);
    }
  } finally { await app.close(); }
});

test('agent receipts exclude foreign prompts and replay, retaining distinct targets for identical instructions', async () => {
  const app = await createSmokeApp({holdPromptReceipts:true});
  const admitted = () => app.reactions.filter(reaction => JSON.stringify(reaction.reaction).includes('🤝'));
  const receipt = (id: string, text: string, from = 'Telegram @FixtureOmpBot') => ({
    type:'custom_message' as const,id,parentId:null,timestamp:new Date().toISOString(),
    customType:'collab-prompt',content:text,details:{from},display:true,
  });
  try {
    await app.update({text:'/setup'});
    await app.update({message_id:3101,text:'/new Initial instruction'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.reactions.map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    app.emit({t:'entry',entry:receipt('foreign','Initial instruction','Web participant')});
    app.emit({t:'snapshot-chunk',entries:[receipt('snapshot','Initial instruction')],final:true});
    assert.deepEqual(admitted(),[]);
    app.emit({t:'entry',entry:receipt('initial','Initial instruction')});
    await eventually(() => admitted().length === 1);
    const session = app.store.listSessions(botId)[0]!;
    for (const message_id of [3102,3103]) {
      await app.update({message_id,message_thread_id:session.threadId,text:'@FixtureOmpBot Same instruction',entities:[{type:'mention',offset:0,length:14}]});
    }
    assert.equal(admitted().length,1);
    app.emit({t:'entry',entry:receipt('first','Same instruction')});
    await eventually(() => admitted().length === 2);
    app.emit({t:'entry',entry:receipt('second','Same instruction')});
    await eventually(() => admitted().length === 3);
    assert.deepEqual(admitted().map(reaction => reaction.message_id),[3101,3102,3103]);
  } finally { await app.close(); }
});

test('bot receipt is delivered before a blocked host startup can receive the instruction', async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const ensure = app.runtime.ensure.bind(app.runtime);
  app.runtime.ensure = async session => {
    entered.resolve();
    await release.promise;
    return ensure(session);
  };
  let updating: Promise<void> | undefined;
  try {
    await app.update({text:'/setup'});
    updating = app.update({message_id:3201,text:'/new Wait for the host'});
    await entered.promise;
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 3201).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    assert.ok(!app.accepted.some(frame => frame.t === 'prompt'));
    release.resolve();
    await updating;
    await eventually(() => app.reactions.some(reaction => reaction.message_id === 3201 && JSON.stringify(reaction.reaction).includes('🤝')));
  } finally {
    release.resolve();
    await updating?.catch(() => undefined);
    await app.close();
  }
});

test('busy streaming tolerates membership lookup latency without dropping frames or bypassing revocation', { timeout: 10_000 }, async () => {
  const app = await createSmokeApp({ authorizationDelayMs: 30 });
  let socket: WebSocket | undefined;
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 31, forum_topic_created: { name: 'Busy stream' } });
    const session = app.store.listSessions(botId)[0]!;
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const { ticket } = await response.json() as { ticket: string };
    socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
    const frames: { t: string; final?: boolean; state?: { queuedMessageCount: number } }[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk' && frame.final));
    const state = { cwd: '/fixture/project', isStreaming: true, participants: [] };
    for (let sequence = 1; sequence <= 220; sequence++) {
      app.emit({ t: 'state', state: { ...state, queuedMessageCount: sequence } });
      await delay(2);
    }
    await eventually(() => frames.some(frame => frame.state?.queuedMessageCount === 220) || socket!.readyState !== WebSocket.OPEN);
    assert.equal(socket.readyState, WebSocket.OPEN, 'membership checks must not starve live output');
    assert.deepEqual(frames.filter(frame => frame.t === 'state').map(frame => frame.state?.queuedMessageCount), Array.from({ length: 220 }, (_, index) => index + 1));
    app.setMember(false);
    const closed = once(socket, 'close');
    app.emit({ t: 'state', state: { ...state, queuedMessageCount: 9999 } });
    await closed;
    assert.ok(!frames.some(frame => frame.state?.queuedMessageCount === 9999), 'batch authorization still denies a removed reader');
  } finally {
    socket?.terminate();
    await app.close();
  }
});

test('capacity approval requires an active configured instance admin, not group administrator rights', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
    assert.equal(request.message.message_thread_id,waiting.threadId);
    assert.match(String(request.message.text),/from 1 to 2/);
    assert.match(String(request.message.text),/Confirmation.*required/);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),true);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Running task'}]);

    app.setCurrentMember({username:'not_the_owner',status:'administrator'});
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1,'the update username cannot substitute for the current member identity');
    app.setMember(false);
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),true);
    assert.equal(app.connectionCount,1);
    app.setMember(true);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(request.approve,request.message);
    await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
    assert.equal(app.runtime.getSessionLimit(),2);
  } finally {
    await app.close();
  }
});

test('one authorized approval admits the pending initial task without replaying submitted instructions', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    await app.callback(request.approve,request.message);
    await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
    assert.equal(app.runtime.getSessionLimit(),2);
    assert.equal(app.config.omp.maxSessions,2,'chat approval persists the actual configured capacity');
    assert.equal(readConfig(app.config.configPath).omp.maxSessions,2);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Running task'},{t:'prompt',text:'Waiting task'},
    ]);
    const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
    assert.equal(app.store.hasPendingInitialTask(waiting.id),false);
    await app.callback(request.approve,request.message);
    await app.callback(request.cancel,request.message);
    assert.equal(app.runtime.getSessionLimit(),2);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,2);
    assert.equal(app.connectionCount,2);
  } finally {
    await app.close();
  }
});

test('a stale confirmation cannot double a limit already increased by another topic', async () => {
  const app = await waitingForCapacity();
  try {
    const first = capacityRequest(app);
    await app.update({text:'/new Another waiting task'});
    const waiting = app.store.listSessions(botId).find(session => session.name === 'Another waiting task')!;
    const stale = capacityRequest(app,waiting.threadId);
    await app.callback(first.approve,first.message);
    await app.callback(stale.approve,stale.message);
    assert.equal(app.runtime.getSessionLimit(),2);
    assert.equal(app.store.hasPendingInitialTask(waiting.id),true);
    assert.ok(!app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Another waiting task'));
    await app.callback(stale.approve,stale.message);
    assert.equal(app.runtime.getSessionLimit(),2);
    await app.update({message_thread_id:waiting.threadId,text:'@FixtureOmpBot Reconnect',entities:[{type:'mention',offset:0,length:14}]});
    const fresh = capacityRequest(app,waiting.threadId);
    assert.notEqual(fresh.approve,stale.approve);
    assert.match(String(fresh.message.text),/from 2 to 4/);
    await app.callback(fresh.approve,fresh.message);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Another waiting task'));
    assert.equal(app.runtime.getSessionLimit(),4);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').map(frame => frame.text),['Running task','Waiting task','Another waiting task']);
  } finally {
    await app.close();
  }
});

test('cancelling a capacity request keeps its initial task pending and cannot later approve', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    await app.callback(request.cancel,request.message);
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.connectionCount,1);
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,1);
    assert.equal(app.store.hasPendingInitialTask(app.store.listSessions(botId).find(session => session.name === 'Waiting task')!.id),true);
  } finally {
    await app.close();
  }
});

test('capacity approvals are bound to the original non-forwarded forum message', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    for (const change of [
      {chat:{id:chatId-1,type:'supergroup',is_forum:true}},
      {chat:{id:chatId,type:'private'}},
      {message_id:Number(request.message.message_id)+1},
      {message_thread_id:Number(request.message.message_thread_id)+1},
      {message_thread_id:undefined},
      {from:{id:123,is_bot:true,first_name:'Other bot'}},
      {forward_origin:{type:'hidden_user',sender_user_name:'Forwarded',date:1}},
      {forward_date:1},
    ]) {
      await app.callback(request.approve,{...request.message,...change});
      assert.equal(app.runtime.getSessionLimit(),1);
      assert.equal(app.connectionCount,1);
    }
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),2,'rejected contexts must not authorize or consume the original confirmation');
  } finally {
    await app.close();
  }
});

test('expired capacity approval cannot raise the session limit', async t => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const expired = Date.now()+300001;
    t.mock.method(Date,'now',() => expired);
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.connectionCount,1);
    assert.match(String(app.messages.at(-1)?.text),/expired/);
  } finally {
    await app.close();
  }
});

test('empty topic creation, initialization, and reopening do not launch managed hosts', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Idle topic',icon_color:7322096}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.initialize();
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    await app.update({message_thread_id:42,forum_topic_reopened:{}});
    assert.equal(app.connectionCount,0);
    assert.equal(await app.runtime.isRunning(session),false);
    await app.update({message_thread_id:42,text:'@FixtureOmpBot Start now',entities:[{type:'mention',offset:0,length:14}]});
    assert.equal(app.connectionCount,1);
    assert.equal(await app.runtime.isRunning(session),true);
  } finally {
    await app.close();
  }
});

test('Mini App prompt relay names the authenticated sender and preserves Unicode without resubmission', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Relay topic',icon_color:7322096}});
    const session = app.store.listSessions(botId)[0]!;
    const before = app.messages.length;
    const prompt = 'a'.repeat(3973)+'😀'.repeat(2100)+'\n<literal>';
    await app.service.relayPrompt(session,{userId:123,username:'ada',displayName:'Ada'},prompt);
    const messages = app.messages.slice(before);
    assert.equal(messages.map(message => message.text).join(''),`@ada posted a prompt: ${prompt}`);
    assert.ok(messages.every(message => String(message.text).length <= 4000 && String(message.text).isWellFormed()));
    assert.ok(messages.every(message => message.message_thread_id === session.threadId && message.parse_mode === undefined));
    await app.service.relayPrompt(session,{userId:456,displayName:'No handle'},'Second prompt');
    assert.equal(app.messages.at(-1)?.text,'No handle (user ID 456) posted a prompt: Second prompt');
    assert.deepEqual(app.accepted,[]);
    assert.equal(app.connectionCount,0);
  } finally {
    await app.close();
  }
});

test('a failed current group authorization leaves the request and capacity unchanged', async t => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const lookup = t.mock.method(app.bot.telegram,'getChat',async () => { throw new Error('Membership lookup unavailable'); });
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),1);
    assert.equal(app.connectionCount,1);
    lookup.mock.restore();
    await app.callback(request.approve,request.message);
    assert.equal(app.runtime.getSessionLimit(),2);
  } finally {
    await app.close();
  }
});

test('initialization admits pending initial tasks without eagerly launching other topics', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    app.store.createSession({botId,chatId,threadId:42,instancePath},'Empty topic');
    const pending = app.store.createSession({botId,chatId,threadId:43,instancePath},'Pending topic',{kind:'managed'},'Restore pending task',123);
    await app.service.initialize();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Restore pending task'}]);
    assert.equal(app.connectionCount,1);
    assert.equal(app.store.hasPendingInitialTask(pending.id),false);
  } finally {
    await app.close();
  }
});

test('retirement admission rejection preserves an unsent initial task for the next listener attempt', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const fence = t.mock.method(app.runtime,'markPrompt',() => { throw new Error('Host is retiring'); });
    await app.update({text:'/new Preserve unsent task'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.accepted.length,0);
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    fence.mock.restore();
    await app.service.initialize();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Preserve unsent task'}]);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
  } finally {
    await app.close();
  }
});

test('opening a lazy topic can establish Telegram mirroring without submitting instructions', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Mini App topic',icon_color:7322096}});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.connectionCount,0);
    const binding = await app.runtime.ensure(session);
    await app.service.ensureMirroring(session,binding);
    app.emit({t:'event',event:{type:'message_end',message:{
      role:'assistant',content:[{type:'text',text:'Mirrored Mini App answer'}],model:'fixture',timestamp:Date.now(),
      stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},
    }}});
    await eventually(() => app.messages.some(message => message.text === 'Mirrored Mini App answer'));
    assert.equal(app.messages.at(-1)?.message_thread_id,session.threadId);
    assert.deepEqual(app.accepted,[]);
  } finally {
    await app.close();
  }
});

test('topic icons distinguish active work, idle live hosts, and process exit without confusing relay loss', async () => {
  const app = await createSmokeApp();
  const running = '5312016608254762256', completed = '5237699328843200968', stopped = '5408906741125490282';
  const icon = () => app.topicEdits.at(-1)?.icon_custom_emoji_id;
  const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Status transitions'}});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(icon(),stopped);
    assert.equal(app.connectionCount,0);
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => icon() === completed);
    app.emit({t:'event',event:{type:'agent_start'}});
    await eventually(() => icon() === running);
    app.emit({t:'state',state:{...state,queuedMessageCount:1}});
    app.emit({t:'event',event:{type:'agent_end'}});
    await delay(50);
    assert.equal(icon(),running,'queued work keeps the topic running between turns');
    app.emit({t:'state',state});
    await eventually(() => icon() === completed);
    assert.equal(await app.runtime.isRunning(session),true,'completion does not imply process exit');
    const beforeDisconnect = app.topicEdits.length;
    app.disconnect();
    await delay(100);
    assert.equal(icon(),completed,'a live process retains its icon when the relay disconnects');
    assert.equal(app.topicEdits.length,beforeDisconnect);
    await eventually(() => app.connectionCount > 1);
    await app.runtime.stop(session.id);
    app.disconnect();
    await eventually(() => icon() === stopped);
    assert.ok(app.topicEdits.every(edit => edit.chat_id === chatId && edit.message_thread_id === 42 && !('name' in edit)));
    assert.deepEqual(app.accepted,[],'status observation never submits instructions');
  } finally {
    await app.close();
  }
});

test('periodic topic status checks detect idle retirement without a relay close event', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Retiring host'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5237699328843200968');
    await app.runtime.stop(session.id);
    t.mock.timers.tick(30000);
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5408906741125490282');
    assert.equal(app.connectionCount,1,'retirement detection does not revive the process');
  } finally {
    await app.close();
  }
});

test('closing a working topic does not claim the process stopped while guarded shutdown is deferred', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Deferred stop'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    app.emit({t:'event',event:{type:'agent_start'}});
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5312016608254762256');
    app.runtime.stop = async () => {};
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    assert.equal(app.topicEdits.at(-1)?.icon_custom_emoji_id,'5312016608254762256');
    app.emit({t:'event',event:{type:'agent_end'}});
    await eventually(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5237699328843200968');
    assert.equal(app.store.getSession(session.id)?.status,'closed');
  } finally {
    await app.close();
  }
});

for (const interactive of [false,true]) {
  test(`${interactive ? 'interactive /new' : '/new task'} copies the original task after the topic entry with relay attribution`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const task = 'Review <literal> auth\nKeep the original formatting 😀';
      if (interactive) {
        await app.update({text:'/new'});
        const request = app.messages.at(-1)!;
        await app.update({text:task,reply_to_message:{message_id:request.message_id}},{
          id:ownerId,first_name:'No',last_name:'Username',is_bot:false,
        });
      } else {
        await app.update({text:`/new ${task}`});
      }
      const session = app.store.listSessions(botId)[0]!;
      const topicMessages = app.messages.filter(message => message.message_thread_id === session.threadId);
      assert.ok(topicMessages[0]?.reply_markup,'the session entry remains first');
      assert.equal(topicMessages[1]?.text,`${interactive ? `No Username (user ID ${ownerId})` : `@${ownerUsername}`} posted a prompt: ${task}`);
      assert.equal(topicMessages[1]?.parse_mode,undefined,'the task is literal text, just like Mini App prompts');
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:task}],'the visible copy is not a second submission');
    } finally {
      await app.close();
    }
  });
}

for (const command of ['stop', 'kill']) {
  test(`/${command} is restricted to authorized instructions in the matching session topic`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Controlled topic'}});
      const session = app.store.listSessions(botId)[0]!;
      await app.service.ensureMirroring(session,await app.runtime.ensure(session));
      for (const message of [
        {text:`/${command}`},
        {text:`/${command}`,message_thread_id:1},
        {text:`/${command}`,message_thread_id:99},
        {text:`/${command}`,message_thread_id:42,chat:{id:123,type:'private'}},
        {text:`/${command}@AnotherBot`,message_thread_id:42},
        {text:`/${command}`,message_thread_id:42,forward_origin:{type:'hidden_user',date:1,sender_user_name:'Forwarder'}},
      ]) await app.update(message);
      app.setMember(false);
      await app.update({text:`/${command}`,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),true);
      assert.deepEqual(app.accepted,[]);
    } finally {
      await app.close();
    }
  });

  test(`/${command} cancels a waiting initial task without starting a host or approving stale capacity`, async () => {
    const app = await waitingForCapacity();
    try {
      const sessions = app.store.listSessions(botId);
      const running = sessions.find(session => session.name === 'Running task')!;
      const waiting = sessions.find(session => session.name === 'Waiting task')!;
      const request = capacityRequest(app,waiting.threadId);
      const connections = app.connectionCount;
      await app.update({text:`/${command}`,message_thread_id:waiting.threadId});
      await app.callback(request.approve,request.message);
      await app.service.initialize();
      assert.equal(app.store.hasPendingInitialTask(waiting.id),false);
      assert.equal(await app.runtime.isRunning(waiting),false);
      assert.equal(await app.runtime.isRunning(running),true);
      assert.equal(app.runtime.getSessionLimit(),1);
      assert.equal(app.connectionCount,connections);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Running task'}]);
    } finally {
      await app.close();
    }
  });

  test(`/${command} cancels startup retries but allows a later explicit instruction`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Rejected initial task'});
      const session = app.store.listSessions(botId)[0]!;
      await app.update({text:`/${command}@FixtureOmpBot`,message_thread_id:session.threadId});
      await delay(400);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
      assert.equal(await app.runtime.isRunning(session),command === 'stop');
      assert.equal(app.store.getSession(session.id)?.status,'open');
      await app.update({text:'@FixtureOmpBot Explicit next task',message_thread_id:session.threadId,entities:[{type:'mention',offset:0,length:14}]});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Explicit next task'}]);
      assert.equal(await app.runtime.isRunning(session),true);
      assert.equal(app.accepted.filter(frame => frame.t === 'abort').length,command === 'stop' ? 1 : 0);
    } finally {
      await app.close();
    }
  });
}

test('/stop on an empty topic does not launch its host', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Empty topic'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({text:'/stop',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.connectionCount,0);
    assert.deepEqual(app.accepted,[]);
  } finally {
    await app.close();
  }
});

test('/kill ends the matching Mini App connection without disconnecting other topics or reconnecting mirroring', async () => {
  const app = await createSmokeApp();
  const clients: WebSocket[] = [];
  try {
    await app.update({text:'/setup'});
    for (const threadId of [42,43]) await app.update({message_thread_id:threadId,forum_topic_created:{name:`Topic ${threadId}`}});
    const [target,other] = app.store.listSessions(botId);
    assert.ok(target && other);
    for (const session of [target,other]) {
      const response = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id)})});
      assert.equal(response.status,200);
      const {ticket} = await response.json() as {ticket:string};
      const socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${ticket}`,{origin:app.config.publicUrl});
      clients.push(socket);
      const frames: HostFrame[] = [];
      socket.on('message',data => frames.push(JSON.parse(data.toString())));
      await once(socket,'open');
      await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk'));
    }
    const connections = app.connectionCount;
    const closed = once(clients[0]!,'close');
    await app.update({text:'/kill',message_thread_id:target.threadId});
    const [code] = await closed;
    assert.equal(code,4003,'explicit termination must not trigger Mini App automatic reconnect');
    await delay(1100);
    assert.equal(app.connectionCount,connections,'Telegram mirroring must not resurrect a killed process');
    assert.equal(await app.runtime.isRunning(target),false);
    assert.equal(await app.runtime.isRunning(other),true);
    assert.equal(clients[1]!.readyState,WebSocket.OPEN);
    assert.equal(app.topicEdits.findLast(edit => edit.message_thread_id === target.threadId)?.icon_custom_emoji_id,'5408906741125490282');
    await app.update({text:'/kill',message_thread_id:target.threadId});
    assert.equal(app.connectionCount,connections,'repeated kill must not launch a process');
  } finally {
    for (const socket of clients) socket.terminate();
    await app.close();
  }
});

test('status icon notices from this bot are deleted without deleting human edits or renames', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Status notices'}});
    const ownBot = {id:botId,first_name:'OMP',is_bot:true};
    await app.update({message_id:1000,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'5408906741125490282'}},ownBot);
    await app.update({message_id:1003,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:''}},ownBot);
    await app.update({message_id:1004,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'5312016608254762256'}});
    await app.update({message_id:1005,message_thread_id:42,forum_topic_edited:{name:'Renamed topic'}});
    await app.update({message_id:1006,message_thread_id:42,forum_topic_edited:{name:'Bot rename',icon_custom_emoji_id:'5237699328843200968'}},ownBot);
    await app.update({message_id:1007,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'5312016608254762256'}},{...ownBot,id:botId+1});
    assert.deepEqual(app.deletedMessages,[1000,1003].map(message_id => ({chat_id:chatId,message_id})));
    assert.equal(app.store.listSessions(botId)[0]?.name,'Bot rename');
    assert.equal(app.connectionCount,0,'processing service notices never starts a host');
  } finally {
    await app.close();
  }
});

for (const readonly of ['file', 'parent'] as const) {
  test(`a capacity confirmation cannot override read-only config ${readonly} permissions`, async () => {
    const app = await waitingForCapacity();
    const target = readonly === 'file' ? app.config.configPath : dirname(app.config.configPath);
    try {
      const request = capacityRequest(app);
      await chmod(target, readonly === 'file' ? 0o400 : 0o500);
      await app.callback(request.approve, request.message);
      assert.equal(app.runtime.getSessionLimit(), 1);
      assert.equal(app.config.omp.maxSessions, 1);
      assert.equal(readConfig(app.config.configPath).omp.maxSessions, 1);
      assert.match(String(app.messages.at(-1)?.text), /read-only/);
      const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
      assert.equal(app.store.hasPendingInitialTask(waiting.id), true);
    } finally {
      await chmod(target, readonly === 'file' ? 0o600 : 0o700);
      await app.close();
    }
  });
}

test('removing an assignment disables output immediately and reconciliation detaches without killing history', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Keep working locally' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const assigned = app.config.instances[session.instancePath]!;
    const chats = assigned.chats;
    const detached: string[] = [];
    app.service.onSessionKill(id => detached.push(id));
    const before = app.messages.length;
    assigned.chats = [];
    app.emit({ t: 'event', event: { type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Must not leak to the removed chat' }], model: 'fixture', timestamp: Date.now(),
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    } } });
    await delay(50);
    assert.equal(app.messages.length, before, 'output is blocked before the reload reconciliation finishes');
    await assert.rejects(app.service.authorize(chatId, ownerId));
    await app.service.reconcileConfiguration();
    assert.deepEqual(detached, [session.id]);
    assert.equal(await app.runtime.isRunning(session), true);
    assert.equal(app.store.getSessionGeneration(session.id), 0);
    assert.equal(app.store.getSession(session.id)?.instancePath, session.instancePath);
    const connections = app.connectionCount;
    assigned.chats = chats;
    await app.service.reconcileConfiguration();
    await eventually(() => app.connectionCount > connections);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Keep working locally' }]);
  } finally {
    await app.close();
  }
});

test('retargeted config cannot authorize, launch or mirror a session pinned to the old path', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Pinned topic' } });
    const session = app.store.listSessions(botId)[0]!;
    const original = app.config.instances[session.instancePath]!;
    delete app.config.instances[session.instancePath];
    app.config.instances[realpathSync(tmpdir())] = original;
    await app.update({ message_thread_id: 42, text: '@FixtureOmpBot Must not launch', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    assert.equal(app.connectionCount, 0);
    assert.equal(app.store.hasPendingInitialTask(session.id), false);
    await assert.rejects(app.service.ensureMirroring(session, { instanceId: 'host', sessionId: 'history', generation: 1, url: 'unused' }));
    assert.equal(app.store.getSession(session.id)?.instancePath, session.instancePath);
  } finally {
    await app.close();
  }
});

test('read-only configuration never offers a runtime-only capacity override', async () => {
  const app = await createSmokeApp({ maxSessions: 1 });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Running task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    await chmod(app.config.configPath, 0o400);
    await app.update({ text: '/new Waiting under read-only configuration' });
    assert.equal(app.runtime.getSessionLimit(), 1);
    assert.equal(app.config.omp.maxSessions, 1);
    assert.ok(app.messages.some(message => String(message.text).includes('Configuration is read-only')));
    assert.equal(app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('capacity:approve:')), false);
  } finally {
    await chmod(app.config.configPath, 0o600);
    await app.close();
  }
});

test('capacity persistence preserves newer CLI configuration rather than overwriting it from memory', async () => {
  const app = await waitingForCapacity();
  try {
    const request = capacityRequest(app);
    const updated = readConfig(app.config.configPath);
    updated.port = 23456;
    updated.omp.args = [...updated.omp.args, '--new-cli-setting'];
    writeConfig(updated);
    await app.callback(request.approve, request.message);
    const persisted = readConfig(app.config.configPath);
    assert.equal(app.runtime.getSessionLimit(), 2);
    assert.equal(app.config.omp.maxSessions, 2);
    assert.equal(persisted.omp.maxSessions, 2);
    assert.equal(persisted.port, 23456);
    assert.ok(persisted.omp.args.includes('--new-cli-setting'));
    assert.equal(app.config.omp.args.includes('--new-cli-setting'), false, 'other in-memory settings are left to reload reconciliation');
  } finally {
    await app.close();
  }
});

for (const change of ['limit', 'admins', 'assignment'] as const) {
  test(`capacity approval respects a newer persisted ${change} change before the watcher catches up`, async () => {
    const app = await waitingForCapacity();
    try {
      const request = capacityRequest(app);
      const updated = readConfig(app.config.configPath);
      const path = Object.keys(updated.instances)[0]!;
      if (change === 'limit') updated.omp.maxSessions = 3;
      else if (change === 'admins') updated.instances[path]!.admins = ['another_admin'];
      else updated.instances[path]!.chats = [];
      writeConfig(updated);
      await app.callback(request.approve, request.message);
      assert.equal(app.runtime.getSessionLimit(), 1);
      assert.equal(app.config.omp.maxSessions, 1);
      assert.deepEqual(readConfig(app.config.configPath), updated);
      const waiting = app.store.listSessions(botId).find(session => session.name === 'Waiting task')!;
      assert.equal(app.store.hasPendingInitialTask(waiting.id), true);
    } finally {
      await app.close();
    }
  });
}

test('default mode starts a session host from ordinary text without a mention', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'All messages'}});
    assert.equal(app.connectionCount,0);
    const rejection = once(app.events,'message');
    await app.update({text:'Implement ordinary text\nwith multiple lines',message_thread_id:42});
    await rejection;
    await app.update({text:'Implement ordinary text\nwith multiple lines',message_thread_id:42});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement ordinary text\nwith multiple lines'},
    ]);
    await app.update({text:'Do not prompt from General'});
    await app.update({text:'/unrecognized command',message_thread_id:42});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement ordinary text\nwith multiple lines'},
    ]);
  } finally { await app.close(); }
});

test('explicit mode ignores discussion, mentions and bot replies, and admits only scoped /p prompts', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.callback('setup:prompts:false',app.messages.at(-1)!);
    const path = Object.keys(app.config.instances)[0]!;
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,false);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Explicit prompts'}});
    const reactions = app.reactions.length;
    await app.update({text:'Ordinary discussion',message_thread_id:42});
    await app.update({text:'@FixtureOmpBot Still discussion',message_thread_id:42,entities:[{type:'mention',offset:0,length:14}]});
    await app.update({text:'A reply is not a prompt',message_thread_id:42,reply_to_message:{message_id:9000,from:{id:botId,is_bot:true,first_name:'OMP'}}});
    assert.equal(app.connectionCount,0);
    assert.equal(app.reactions.length,reactions);
    await app.update({text:'/p',message_thread_id:42});
    await app.update({text:'/p@AnotherBot Not for this bot',message_thread_id:42});
    await app.update({text:'/p Forwarded instruction',message_thread_id:42,forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}});
    assert.equal(app.connectionCount,0);
    const rejection = once(app.events,'message');
    await app.update({message_id:7100,text:'/p@FixtureOmpBot Implement explicit text\nwith multiple lines',message_thread_id:42});
    await rejection;
    await app.update({message_id:7100,text:'/p@FixtureOmpBot Implement explicit text\nwith multiple lines',message_thread_id:42});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement explicit text\nwith multiple lines'},
    ]);
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.getReplyTarget(session.id),7100);
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    await app.update({text:'/p Archived instruction',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement explicit text\nwith multiple lines'},
    ]);
    await app.update({text:'/setup'});
    await app.callback('setup:prompts:true',app.messages.at(-1)!);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,true);
  } finally { await app.close(); }
});

test('prompt mode changes require current instance administration and writable configuration', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const setup = app.messages.at(-1)!;
    const path = Object.keys(app.config.instances)[0]!;
    for (const member of [
      {username:'another_admin',status:'administrator' as const},
    ]) {
      app.setCurrentMember(member);
      await app.callback('setup:prompts:false',setup);
      assert.notEqual(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,false);
    }
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await chmod(app.config.configPath,0o400);
    await app.callback('setup:prompts:false',setup);
    assert.notEqual(app.config.instances[path]!.chats[0]!.all_messages_are_prompts,false);
    assert.notEqual(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,false);
    await chmod(app.config.configPath,0o600);
    await app.callback('setup:prompts:false',setup);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,false);
  } finally { await app.close(); }
});

for (const allMessagesArePrompts of [true, false]) {
  for (const interactive of [true, false]) {
    test(`/p in General creates a session like /new (all messages: ${allMessagesArePrompts}, interactive: ${interactive})`, async () => {
      const app = await createSmokeApp();
      try {
        await app.update({text:'/setup'});
        if (!allMessagesArePrompts) await app.callback('setup:prompts:false',app.messages.at(-1)!);
        await app.update({text:interactive ? '/p@FixtureOmpBot' : '/p@FixtureOmpBot Create from General',message_thread_id:1});
        if (interactive) {
          assert.equal(app.store.listSessions(botId).length,0);
          await app.update({text:'Create from General',reply_to_message:app.messages.at(-1)!,message_thread_id:1});
        }
        await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
        const session = app.store.listSessions(botId)[0]!;
        assert.notEqual(session.threadId,1);
        assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Create from General'}]);
        assert.equal(app.store.getTopic({botId,chatId,threadId:1}),undefined);
      } finally { await app.close(); }
    });
  }
}

test('explicit mode preserves the interactive /new task reply', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.callback('setup:prompts:false',app.messages.at(-1)!);
    await app.update({text:'/new'});
    const request = app.messages.at(-1)!;
    await app.update({text:'Create this explicit-mode session',reply_to_message:request});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Create this explicit-mode session'},
    ]);
  } finally { await app.close(); }
});

function promptProposal(app: {messages:Record<string, unknown>[]}) {
  const message = app.messages.findLast(message => JSON.stringify(message.reply_markup)?.includes('prompt:approve:'));
  assert.ok(message,'a proposal must present an approval button');
  const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(message.reply_markup);
  return {message,approve:markup.inline_keyboard[0]![0]!.callback_data};
}

for (const allMessagesArePrompts of [true,false]) {
  test(`non-admin prompts are ignored by default with all_messages_are_prompts=${allMessagesArePrompts}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (!allMessagesArePrompts) await app.callback('setup:prompts:false',app.messages.at(-1)!);
      await app.update({message_thread_id:42,forum_topic_created:{name:'Admin prompts only'}});
      app.setCurrentMember({username:'another_user',status:'administrator'});
      const before = app.messages.length;
      const reactions = app.reactions.length;
      await app.update({text:allMessagesArePrompts ? 'Ignored task' : '/p Ignored task',message_thread_id:42});
      await app.update({text:'/new Ignored new session'});
      await app.update({text:'/new'});
      assert.equal(app.messages.length,before);
      assert.equal(app.reactions.length,reactions);
      assert.equal(app.connectionCount,0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });

  test(`non-admin prompts wait for one instance-admin approval with all_messages_are_prompts=${allMessagesArePrompts}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.callback('setup:proposals:true',app.messages.at(-1)!);
      if (!allMessagesArePrompts) await app.callback('setup:prompts:false',app.messages.at(-1)!);
      await app.update({text:'/new Seed task'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      const path = Object.keys(app.config.instances)[0]!;
      assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.users_can_propose_prompts,true);
      const proposer = {id:ownerId+5,first_name:'Grace',username:'grace',is_bot:false};
      app.setCurrentMember({username:'grace',status:'administrator'});
      await app.update({message_id:8100,text:allMessagesArePrompts ? 'Proposed multiline\n  task' : '/p Proposed multiline\n  task',message_thread_id:session.threadId},proposer);
      const proposal = promptProposal(app);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
      await app.callback(proposal.approve,proposal.message,proposer);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
      app.setCurrentMember({username:ownerUsername,status:'member'});
      await app.callback(proposal.approve,{...proposal.message,message_thread_id:session.threadId+1});
      await app.callback(proposal.approve,{...proposal.message,message_id:Number(proposal.message.message_id)+1});
      await app.callback(proposal.approve,{...proposal.message,forward_date:1});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
      await app.callback(proposal.approve,proposal.message);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'Seed task'},{t:'prompt',text:'Proposed multiline\n  task'},
      ]);
      assert.equal(app.store.getReplyTarget(session.id),8100);
      assert.deepEqual(proposal.message.reply_markup,{inline_keyboard:[]});
      await app.callback(proposal.approve,proposal.message);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'Seed task'},{t:'prompt',text:'Proposed multiline\n  task'},
      ]);
      await app.update({text:allMessagesArePrompts ? 'Direct admin task' : '/p Direct admin task',message_thread_id:session.threadId});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'Seed task'},{t:'prompt',text:'Proposed multiline\n  task'},{t:'prompt',text:'Direct admin task'},
      ]);
    } finally { await app.close(); }
  });
}

for (const invalidation of ['disabled','archived','killed','removed','expired','requester-left'] as const) {
  test(`a ${invalidation} proposal cannot execute on approval`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.callback('setup:proposals:true',app.messages.at(-1)!);
      await app.update({text:'/new Seed task'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      app.setCurrentMember({username:'grace',status:'member'});
      await app.update({text:'Must not execute',message_thread_id:session.threadId});
      const proposal = promptProposal(app);
      app.setCurrentMember({username:ownerUsername,status:'member'});
      if (invalidation === 'disabled') app.config.instances[session.instancePath]!.chats[0]!.users_can_propose_prompts = false;
      else if (invalidation === 'archived') await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
      else if (invalidation === 'killed') await app.update({text:'/kill',message_thread_id:session.threadId});
      else if (invalidation === 'removed') app.config.instances[session.instancePath]!.chats = [];
      else if (invalidation === 'expired') {
        const now = Date.now();
        t.mock.method(Date,'now',() => now+600001);
      } else {
        const getMember = app.bot.telegram.getChatMember.bind(app.bot.telegram);
        t.mock.method(app.bot.telegram,'getChatMember',async (...args: Parameters<typeof getMember>) => {
          const member = await getMember(...args);
          return args[1] === ownerId ? {...member,status:'left' as const} : member;
        });
        await app.callback(proposal.approve,proposal.message,{id:ownerId+10,first_name:'Other admin',username:ownerUsername,is_bot:false});
      }
      if (invalidation !== 'requester-left') await app.callback(proposal.approve,proposal.message);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
    } finally { await app.close(); }
  });
}

test('a non-admin /new task creates no session until an instance admin approves', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.update({text:'/setup'});
    await app.callback('setup:proposals:true',app.messages.at(-1)!);
    app.setCurrentMember({username:'grace',status:'member'});
    await app.update({text:'/new Proposed initial task'});
    const proposal = promptProposal(app);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(app.connectionCount,0);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(proposal.approve,proposal.message);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Proposed initial task'}]);
    assert.equal(app.store.listSessions(botId)[0]!.name,'Proposed initial task');
  } finally { await app.close(); }
});

test('approval reviews a literal Unicode-safe copy and submits the same stored proposal text', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.callback('setup:proposals:true',app.messages.at(-1)!);
    await app.update({text:'/new Seed task'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const proposer = {id:ownerId+5,first_name:'Grace',username:'grace',is_bot:false};
    const text = '😀'.repeat(2047)+'x';
    app.setCurrentMember({username:'grace',status:'member'});
    const before = app.messages.length;
    await app.update({text,message_thread_id:session.threadId},proposer);
    const copies = app.messages.slice(before,-1);
    assert.equal(copies.map(message => message.text).join(''),`@grace proposed a prompt:\n${text}`);
    for (const message of copies) {
      assert.ok(String(message.text).length <= 4000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(String(message.text)));
      assert.equal(message.parse_mode,undefined);
    }
    const proposal = promptProposal(app);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(proposal.approve,proposal.message);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Seed task'},{t:'prompt',text},
    ]);
  } finally { await app.close(); }
});
