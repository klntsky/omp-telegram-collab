import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { createBot, type BotService } from '../src/bot.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { SessionTitleUnsupportedError } from '../src/runtime.js';
import { botId, botToken, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};

test('Git status composes with human titles and refreshes without a native name', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Readable title'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    for (const [metadata,prefix] of [
      [{worktree:true,branch:'feature/topic'},'wt:feature/topic '],
      [{worktree:true},'wt: '],
      [{worktree:false,branch:'feature/other'},'feature/other '],
      [{worktree:false},''],
    ] as const) {
      app.topicTitleStatuses.set(session.id,metadata);
      app.emit({t:'state',state});
      await eventually(() => app.store.getSession(session.id)?.name === `${prefix}Readable title`);
    }
    assert.equal(app.sessionTitles.get(session.id),'Readable title');
    app.topicTitleStatuses.set(session.id,{worktree:true,branch:'feature/reconnect'});
    app.disconnect();
    await eventually(() => app.store.getSession(session.id)?.name === 'wt:feature/reconnect Readable title');
  } finally { await app.close(); }
});

test('manual edits strip prior status and restore current status without native title support or bot loops', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Initial'}});
    const session = app.store.listSessions(botId)[0]!;
    app.topicTitleStatuses.set(session.id,{worktree:true,branch:'feature/old'});
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getSession(session.id)?.name === 'wt:feature/old Initial');
    app.topicTitleStatuses.set(session.id,{worktree:false,branch:'feature/new'});
    app.emit({t:'state',state});
    await eventually(() => app.store.getSession(session.id)?.name === 'feature/new Initial');
    await app.update({message_thread_id:42,forum_topic_edited:{name:'wt:feature/old Edited'}});
    await eventually(() => app.sessionTitles.get(session.id) === 'Edited');
    assert.equal(app.store.getSession(session.id)?.name,'feature/new Edited');
    app.runtime.setSessionTitle = async () => { throw new SessionTitleUnsupportedError('Unsupported fixture title control'); };
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Prefix deleted'}});
    assert.equal(app.store.getSession(session.id)?.name,'feature/new Prefix deleted');
    await app.update({message_thread_id:42,forum_topic_edited:{name:'feature/new Repeated'}});
    assert.equal(app.store.getSession(session.id)?.name,'feature/new Repeated');
    const before = app.topicEdits.length;
    await app.update({message_thread_id:42,forum_topic_edited:{name:'wt:feature/old Delayed echo'}},{id:botId,first_name:'OMP',is_bot:true});
    assert.equal(app.topicEdits.length,before);
    assert.equal(app.store.getSession(session.id)?.name,'feature/new Repeated');
    const longTitle = '😀'.repeat(140);
    app.emit({t:'state',state:{...state,sessionName:longTitle}});
    await eventually(() => app.store.getSession(session.id)?.name === `feature/new ${'😀'.repeat(116)}`);
    assert.equal(Array.from(app.store.getSession(session.id)!.name).length,128);
  } finally { await app.close(); }
});

test('restart retains generated prefix knowledge before a native welcome', async () => {
  const app = await createSmokeApp({persistentStore:true});
  let restarted: BotService | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Original'}});
    const session = app.store.listSessions(botId)[0]!;
    app.topicTitleStatuses.set(session.id,{worktree:false,branch:'old-branch'});
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Original'}});
    assert.equal(app.store.getSession(session.id)?.name,'old-branch Original');
    await app.service.close();
    app.topicTitleStatuses.set(session.id,{worktree:true,branch:'new-branch'});
    restarted = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,
      bot:new Bot(botToken,{client:{apiRoot:app.telegramUrl}}),telegramIntervalMs:0});
    await restarted.initialize();
    const chat = {id:chatId,type:'supergroup',title:'Fixture project',is_forum:true} as const;
    const from = {id:ownerId,is_bot:false,first_name:'Ada',username:ownerUsername};
    await restarted.bot.handleUpdate({update_id:9001,message:{message_id:9001,date:0,chat,from,message_thread_id:42,
      forum_topic_edited:{name:'old-branch New human title'}}});
    assert.equal(app.store.getPendingSessionTitle(session.id),'New human title');
    assert.equal(app.store.getSession(session.id)?.name,'wt:new-branch New human title');
    await restarted.bot.handleUpdate({update_id:9002,message:{message_id:9002,date:0,chat,from,message_thread_id:42,
      forum_topic_edited:{name:'wt:stale/branch Final title'}}});
    assert.equal(app.store.getPendingSessionTitle(session.id),'Final title');
    assert.equal(app.store.getSession(session.id)?.name,'wt:new-branch Final title');
    assert.equal(app.connectionCount,0);
  } finally { await restarted?.close(); await app.close(); }
});

test('long Git branches retain readable text and their displayed prefix can be edited', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Readable title'}});
    const session = app.store.listSessions(botId)[0]!;
    app.topicTitleStatuses.set(session.id,{worktree:false,branch:'feature/'+ 'x'.repeat(140)});
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Readable title'}});
    const name = app.store.getSession(session.id)!.name;
    assert.ok(name.endsWith('… Readable title'));
    assert.equal(Array.from(name).length,128);
    await app.update({message_thread_id:42,forum_topic_edited:{name:name.replace('Readable title','Edited title')}});
    assert.equal(app.store.getPendingSessionTitle(session.id),'Edited title');
    assert.ok(app.store.getSession(session.id)!.name.endsWith('… Edited title'));
  } finally { await app.close(); }
});

test('a superseded successful Telegram edit reconciles an unchanged-name response', async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Readable title'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    let attempts = 0;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (method === 'editForumTopic' && 'name' in payload && payload.name === 'feature/race Readable title') {
        attempts++;
        if (attempts > 1) return {ok:false,error_code:400,description:'Bad Request: TOPIC_NOT_MODIFIED'};
        const result = await previous(method,payload,signal);
        entered.resolve();
        await release.promise;
        return result;
      }
      return previous(method,payload,signal);
    });
    app.topicTitleStatuses.set(session.id,{worktree:false,branch:'feature/race'});
    app.emit({t:'state',state});
    await entered.promise;
    app.emit({t:'state',state});
    release.resolve();
    await eventually(() => app.store.getTopicTitlePrefix(session.id) === 'feature/race');
    assert.equal(app.store.getSession(session.id)?.name,'feature/race Readable title');
    assert.equal(attempts,2);
    await app.update({message_thread_id:42,forum_topic_edited:{name:'feature/race Edited'}});
    assert.equal(app.sessionTitles.get(session.id),'Edited');
  } finally { release.resolve(); await app.close(); }
});
