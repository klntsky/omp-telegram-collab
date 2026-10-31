import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { createBot, type BotService, type RuntimeLike } from '../src/bot.js';
import { Store } from '../src/store.js';
import type { CollabHandlers, HostBinding, TopicSession } from '../shared/contracts.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';
import { botId, botToken, chatId } from './telegram-data.js';

const runningIcon = '5312016608254762256';
const finishIcon = '5408906741125490282';
const idle = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
const chat = {id:chatId,type:'supergroup',title:'Fixture project',is_forum:true} as const;

function welcome(binding: HostBinding, handlers: CollabHandlers) {
  handlers.onFrame({t:'welcome',proto:3,header:{type:'session',id:binding.sessionId,cwd:idle.cwd,timestamp:new Date().toISOString()},
    state:idle,agents:[],entryCount:0});
}

interface IconApp {
  update(message: Record<string,unknown>): Promise<void>;
  store: Store;
  service: BotService;
  runtime: Pick<RuntimeLike,'ensure'>;
  topicEdits: Record<string,unknown>[];
}

async function liveTopic(app: IconApp) {
  await app.update({text:'/setup'});
  await app.update({message_thread_id:42,forum_topic_created:{name:'Activity recovery'}});
  const session = app.store.listSessions(botId)[0]!;
  await app.service.ensureMirroring(session,await app.runtime.ensure(session));
  await eventually(() => app.topicEdits.some(edit => edit.icon_custom_emoji_id === finishIcon));
  return session;
}

function lastIcon(app: {topicEdits: Record<string,unknown>[]}) {
  return app.topicEdits.findLast(edit => edit.icon_custom_emoji_id !== undefined)?.icon_custom_emoji_id;
}

test('idle restart repairs an applied icon whose acknowledgement was lost and retains the finish preference', {timeout:15000}, async () => {
  const app = await createSmokeApp({persistentStore:true});
  let restarted: BotService | undefined;
  let reopened: Store | undefined;
  try {
    const session = await liveTopic(app);
    await app.update({message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'human-selected-icon'}});
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      const result = await previous(method,payload,signal);
      if (method === 'editForumTopic' && 'icon_custom_emoji_id' in payload && payload.icon_custom_emoji_id === runningIcon) {
        throw new Error('Telegram applied the icon but its acknowledgement was lost');
      }
      return result;
    });
    app.emit({t:'event',event:{type:'agent_start'}});
    await eventually(() => lastIcon(app) === runningIcon);
    await app.service.close();
    reopened = new Store(join(app.config.dataDir,'telegram.sqlite'));
    restarted = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:reopened,runtime:app.runtime,
      bot:new Bot(botToken,{client:{apiRoot:app.telegramUrl}}),connect:async (binding,_name,handlers) => {
        welcome(binding,handlers);
        return {send(){ throw new Error('Icon recovery must not submit a frame'); },close(){}};
      }});
    await restarted.initialize();
    restarted.startBackground();
    await eventually(() => lastIcon(app) === 'human-selected-icon');
    assert.equal(reopened.getTopicFinishIcon(session.id),'human-selected-icon');
    assert.equal(await app.runtime.isRunning(session),true);
    assert.deepEqual(app.accepted,[]);
    await restarted.bot.handleUpdate({update_id:9002,message:{message_id:9002,date:0,chat,
      from:{id:botId,is_bot:true,first_name:'OMP'},message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:''}}});
    assert.equal(reopened.getTopicFinishIcon(session.id),'human-selected-icon');
  } finally { await restarted?.close(); reopened?.close(); await app.close(); }
});

test('an in-flight activity edit cannot swallow a later human preference and idle transition', {timeout:15000}, async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const session = await liveTopic(app);
    let held = false;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (!held && method === 'editForumTopic' && 'icon_custom_emoji_id' in payload && payload.icon_custom_emoji_id === runningIcon) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return previous(method,payload,signal);
    });
    app.emit({t:'event',event:{type:'agent_start'}});
    await entered.promise;
    await app.update({message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:''}});
    app.emit({t:'state',state:idle});
    release.resolve();
    await eventually(() => lastIcon(app) === '');
    assert.equal(app.store.getTopicFinishIcon(session.id),'');
    assert.equal(await app.runtime.isRunning(session),true);
    assert.deepEqual(app.accepted,[]);
  } finally { release.resolve(); await app.close(); }
});

test('expired confirmation repairs a late remote icon overwrite without a new activity transition', {timeout:15000}, async t => {
  const app = await createSmokeApp();
  try {
    await liveTopic(app);
    const edit = app.bot.api.editForumTopic.bind(app.bot.api);
    await edit(chatId,42,{icon_custom_emoji_id:runningIcon});
    assert.equal(lastIcon(app),runningIcon);
    const now = Date.now();
    t.mock.method(Date,'now',() => now+30*60*1000);
    app.emit({t:'state',state:idle});
    await eventually(() => lastIcon(app) === finishIcon);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('maintenance restores a missing mirror without host admission or prompt replay', {timeout:15000}, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp();
  let restarted: BotService | undefined;
  try {
    const session = await liveTopic(app);
    await app.bot.api.editForumTopic(chatId,42,{icon_custom_emoji_id:runningIcon});
    await app.service.close();
    t.mock.method(app.runtime,'ensure',async () => { throw new Error('Observation recovery must not launch a host'); });
    let available = false;
    let attempts = 0;
    restarted = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,
      bot:new Bot(botToken,{client:{apiRoot:app.telegramUrl}}),connect:async (binding,_name,handlers) => {
        attempts++;
        if (!available) throw new Error('Relay temporarily unavailable');
        welcome(binding,handlers);
        return {send(){ throw new Error('Observation recovery must not submit work'); },close(){}};
      }});
    await restarted.initialize();
    restarted.startBackground();
    await eventually(() => attempts > 0);
    available = true;
    t.mock.timers.tick(30000);
    await eventually(() => lastIcon(app) === finishIcon);
    assert.equal(await app.runtime.isRunning(session),true);
    assert.deepEqual(app.accepted,[]);
  } finally { await restarted?.close(); await app.close(); }
});

test('maintenance retries a dirty icon while unrelated frames arrive during host lookup', {timeout:15000}, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp();
  const failed = Promise.withResolvers<void>();
  const failure = new Error('Temporary icon delivery failure');
  const warn = console.warn.bind(console);
  t.mock.method(console,'warn',(...args: unknown[]) => {
    warn(...args);
    if (args.includes(failure)) failed.resolve();
  });
  try {
    await liveTopic(app);
    let reject = true;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (reject && method === 'editForumTopic' && 'icon_custom_emoji_id' in payload && payload.icon_custom_emoji_id === runningIcon) {
        reject = false;
        throw failure;
      }
      return previous(method,payload,signal);
    });
    app.emit({t:'event',event:{type:'agent_start'}});
    await failed.promise;
    const isRunning = app.runtime.isRunning.bind(app.runtime);
    t.mock.method(app.runtime,'isRunning',async (session: TopicSession) => {
      app.emit({t:'event',event:{type:'notice',level:'info',source:'fixture',message:'Unrelated host output'}});
      return isRunning(session);
    });
    t.mock.timers.tick(30000);
    await eventually(() => lastIcon(app) === runningIcon);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});


test('maintenance retries pending initial authorization with an already connected listener', {timeout:15000}, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const ensure = app.runtime.ensure.bind(app.runtime);
    let armed = false;
    let failed = false;
    t.mock.method(app.runtime,'ensure',async (session: TopicSession) => {
      const binding = await ensure(session);
      armed = true;
      return binding;
    });
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (armed && !failed && method === 'getChat') {
        failed = true;
        throw new Error('Temporary initial-task authorization lookup failure');
      }
      return previous(method,payload,signal);
    });
    await app.update({text:'/new Preserve pending authorization'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    assert.equal(app.connectionCount,1);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    t.mock.timers.tick(30000);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Preserve pending authorization'}]);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
    assert.equal(app.connectionCount,1);
  } finally { await app.close(); }
});
