import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';
import { Bot } from 'grammy';
import { createBot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { join } from 'node:path';
import { botToken } from './telegram-data.js';
import type { GuestFrame } from '@oh-my-pi/pi-wire';

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

test('reconciliation admits pending initial tasks without eagerly launching other topics', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    app.store.createSession({botId,chatId,threadId:42,instancePath},'Empty topic');
    const pending = app.store.createSession({botId,chatId,threadId:43,instancePath},'Pending topic',{kind:'managed'},{text:'Restore pending task'},123,ownerId);
    await app.service.reconcileConfiguration();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Restore pending task'}]);
    assert.equal(app.connectionCount,1);
    assert.equal(app.store.hasPendingInitialTask(pending.id),false);
  } finally {
    await app.close();
  }
});

test('a replacement bot starts a persisted image-only task and preserves it through startup retry', async () => {
  const app = await createSmokeApp({persistentStore:true});
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    const content = {text:'',images:[{type:'image' as const,data:'aW1hZ2U=',mimeType:'image/png'}]};
    const session = app.store.createSession({botId,chatId,threadId:44,instancePath},'Image task',undefined,content,ownerId,ownerId);
    await app.service.close();
    const store = new Store(join(app.config.dataDir,'telegram.sqlite'));
    const bot = new Bot(botToken,{client:{apiRoot:app.telegramUrl}});
    const attempts: GuestFrame[] = [];
    const service = createBot({
      config:app.config,botConfig:app.config.bots[0]!,token:botToken,store,runtime:app.runtime,bot,
      connect:async (_binding,name,handlers) => ({
        send(frame) {
          if (frame.t !== 'prompt') return;
          attempts.push(frame);
          queueMicrotask(() => handlers.onFrame(attempts.length === 1
            ? {t:'error',message:'prompting is unavailable until the host finishes starting up'}
            : {t:'entry',entry:{type:'custom_message',customType:'collab-prompt',content:[{type:'text',text:frame.text},...frame.images!],details:{from:name},display:true,id:'image-admitted',parentId:null,timestamp:new Date().toISOString()}}));
        },
        close() {},
      }),
    });
    try {
      await service.initialize();
      await service.reconcileConfiguration();
      await eventually(() => attempts.length === 2);
      assert.deepEqual(attempts,[{t:'prompt',...content},{t:'prompt',...content}]);
      assert.equal(store.hasPendingInitialTask(session.id),false);
      assert.equal(store.getInitialAuthority(session.id),ownerId);
    } finally { await service.close(); store.close(); }
  } finally { await app.close(); }
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
    app.disconnect();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Preserve unsent task'}]);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
  } finally {
    await app.close();
  }
});


for (const enabled of [false,true]) {
  test(`session entry preserves Telegram prompting with Mini App ${enabled ? 'enabled' : 'disabled'}`, async () => {
    const app = await createSmokeApp();
    try {
      if (!enabled) {
        app.config.publicUrl = '';
        delete app.config.bots[0]!.miniAppShortName;
      }
      await app.service.reconcileConfiguration();
      await app.update({text:'/setup'});
      await app.update({text:'/new Work through Telegram'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      const pin = app.pins.find(value => value.chat_id === chatId);
      assert.ok(pin);
      const entry = app.messages.find(value => value.message_id === pin.message_id)!;
      const markup = entry.reply_markup as {inline_keyboard: {url?:string}[][]};
      const urls = markup.inline_keyboard.flat().flatMap(button => button.url ? [button.url] : []);
      assert.deepEqual(urls,enabled ? [`https://t.me/FixtureOmpBot/app?startapp=s_${session.id}`] : []);
      for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId}]) {
        const commands = await app.bot.api.getMyCommands({scope});
        assert.equal(commands.some(command => command.command === 'session'),enabled);
        assert.ok(commands.some(command => command.command === 'p'));
      }
      const before = app.messages.length;
      await app.update({text:'/session',message_thread_id:session.threadId});
      const response = app.messages.slice(before);
      assert.equal(response.some(message => JSON.stringify(message.reply_markup ?? {}).includes(`startapp=s_${session.id}`)),enabled);
      await app.update({text:'/p Continue in Telegram',message_thread_id:session.threadId});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Continue in Telegram'));
      assert.equal(app.store.listSessions(botId).length,1);
    } finally { await app.close(); }
  });
}

test('runtime mode changes update existing entry links without replacing pins or disconnecting Telegram', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Keep this topic'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const pins = structuredClone(app.pins);
    const connections = app.connectionCount;
    const publicUrl = app.config.publicUrl;
    app.config.publicUrl = '';
    await app.service.reconcileConfiguration();
    assert.deepEqual(app.pins,pins);
    const entry = app.messages.find(value => value.message_id === pins[0]!.message_id)!;
    assert.deepEqual(entry.reply_markup,{inline_keyboard:[]});
    await app.update({text:'/p Still connected',message_thread_id:session.threadId});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Still connected'));
    assert.equal(app.connectionCount,connections);
    app.config.publicUrl = publicUrl;
    await app.service.reconcileConfiguration();
    const markup = entry.reply_markup as {inline_keyboard:{url?:string}[][]};
    assert.ok(markup.inline_keyboard.flat().some(button => button.url?.endsWith(`startapp=s_${session.id}`)));
    assert.deepEqual(app.pins,pins);
  } finally { await app.close(); }
});

test('replacement bot services reconcile persisted pinned entries across mode changes', async () => {
  const app = await createSmokeApp({persistentStore:true});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Preserve persisted entry'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const persisted = app.store.getSessionEntry(session.id)!;
    const entry = app.messages.find(message => message.message_id === persisted.messageId)!;
    const pins = structuredClone(app.pins);
    const publicUrl = app.config.publicUrl;
    await app.service.close();
    for (const enabled of [false,true]) {
      app.config.publicUrl = enabled ? publicUrl : '';
      const store = new Store(join(app.config.dataDir,'telegram.sqlite'));
      const bot = new Bot(botToken,{client:{apiRoot:app.telegramUrl}});
      const service = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store,runtime:app.runtime,bot});
      try {
        await service.initialize();
        const markup = entry.reply_markup as {inline_keyboard:{url?:string}[][]};
        const urls = markup.inline_keyboard.flat().flatMap(button => button.url ? [button.url] : []);
        assert.deepEqual(urls,enabled ? [`https://t.me/FixtureOmpBot/app?startapp=s_${session.id}`] : []);
        assert.equal(store.getSessionEntry(session.id)!.messageId,persisted.messageId);
        assert.deepEqual(app.pins,pins);
        const commands = await bot.api.getMyCommands({scope:{type:'chat',chat_id:chatId}});
        assert.equal(commands.some(command => command.command === 'session'),enabled);
      } finally { await service.close(); store.close(); }
    }
  } finally { await app.close(); }
});

for (const outcome of ['missing','unchanged'] as const) {
  test(`replacement bot converges pinned entry metadata after Telegram reports ${outcome}`, async () => {
    const app = await createSmokeApp({persistentStore:true});
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Recover pinned entry'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      const entry = app.store.getSessionEntry(session.id)!;
      await app.service.close();
      app.config.publicUrl = '';
      const store = new Store(join(app.config.dataDir,'telegram.sqlite'));
      const bot = new Bot(botToken,{client:{apiRoot:app.telegramUrl}});
      let edits = 0;
      bot.api.config.use(async (previous,method,payload,signal) => {
        if (method !== 'editMessageReplyMarkup') return previous(method,payload,signal);
        edits++;
        if (outcome === 'unchanged') await previous(method,payload,signal);
        return {ok:false,error_code:400,description:outcome === 'missing'
          ? 'Bad Request: message to edit not found'
          : 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'};
      });
      const service = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store,runtime:app.runtime,bot});
      try {
        await service.initialize();
        assert.deepEqual(store.getSessionEntry(session.id),outcome === 'missing'
          ? undefined : {messageId:entry.messageId,markup:JSON.stringify({inline_keyboard:[]})});
        const commands = await bot.api.getMyCommands({scope:{type:'chat',chat_id:chatId}});
        assert.ok(commands.some(command => command.command === 'p'));
        assert.equal(commands.some(command => command.command === 'session'),false);
        assert.equal(edits,1);
      } finally { await service.close(); store.close(); }
    } finally { await app.close(); }
  });
}
