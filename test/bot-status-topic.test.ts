import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot, type BotService } from '../src/bot.js';
import { eventually } from './bot-test-helpers.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId } from './telegram-data.js';

test('status notices create and reuse a reserved topic without creating a session', async () => {
  const app = await createSmokeApp();
  try {
    assert.equal(app.store.getBotStatusTopic(botId, chatId), undefined);
    await app.service.sendStatusNotice(chatId, 'Online');
    const threadId = app.store.getBotStatusTopic(botId, chatId);
    assert.ok(threadId);
    assert.equal(app.createdTopics.length, 1);
    await app.service.sendStatusNotice(chatId, 'Winding down');
    assert.equal(app.createdTopics.length, 1);
    assert.deepEqual(app.messages.map(message => message.message_thread_id), [threadId, threadId]);
    assert.deepEqual(app.store.listSessions(botId), []);
    assert.equal(app.store.getBotStatusTopic(botId + 1, chatId), undefined);
    assert.equal(app.store.getBotStatusTopic(botId, chatId - 1), undefined);
    assert.equal(app.connectionCount, 0);
  } finally { await app.close(); }
});

test('status notices reuse the saved topic and replace it when Telegram reports it missing', async () => {
  const app = await createSmokeApp();
  try {
    app.store.setBotStatusTopic(botId, chatId, 900);
    await app.service.sendStatusNotice(chatId, 'Saved topic');
    assert.equal(app.createdTopics.length, 0);
    assert.equal(app.messages.at(-1)?.message_thread_id, 900);
    const attempts: number[] = [];
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'sendMessage') {
        assert.ok('message_thread_id' in payload);
        const thread = payload.message_thread_id;
        assert.ok(typeof thread === 'number');
        attempts.push(thread);
        if (thread === 900) return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };
      }
      return previous(method, payload, signal);
    });
    await app.service.sendStatusNotice(chatId, 'Replacement topic');
    const replacement = app.store.getBotStatusTopic(botId, chatId);
    assert.ok(replacement);
    assert.notEqual(replacement, 900);
    assert.deepEqual(attempts, [900, replacement]);
    assert.equal(app.createdTopics.length, 1);
    assert.equal(app.messages.at(-1)?.message_thread_id, replacement);
    await app.service.sendStatusNotice(chatId, 'Reuse replacement');
    assert.equal(app.createdTopics.length, 1);
    assert.equal(app.messages.at(-1)?.message_thread_id, replacement);
    assert.deepEqual(app.store.listSessions(botId), []);
  } finally { await app.close(); }
});

for (const origin of ['status', 'command'] as const) {
  test(`${origin} detachment without a session ignores lifecycle, prompts, and worktree commands`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (origin === 'status') await app.service.sendStatusNotice(chatId, 'Online');
      const threadId = origin === 'status' ? app.store.getBotStatusTopic(botId,chatId)! : 42;
      if (origin === 'command') await app.update({message_thread_id:threadId,text:'/detach'});
      assert.equal(app.store.getTopicKind({botId,chatId,threadId}),'detached');
      let probes = 0;
      let worktrees = 0;
      t.mock.method(app.runtime,'topicTitleStatus',async () => { probes++; return {worktree:true,branch:'must-not-appear'}; });
      t.mock.method(app.runtime,'worktree',async () => { worktrees++; });
      const edits = app.topicEdits.length;
      for (const update of [
        {forum_topic_created:{name:'Conversation'}},
        {forum_topic_edited:{name:'Human title'}},
        {forum_topic_closed:{}},
        {forum_topic_reopened:{}},
        {text:'/skill:find-skills'},
        {text:'/p Must not prompt'},
        {text:'/worktree'},
        {text:'Ordinary conversation'},
        {text:'Reply must not prompt',reply_to_message:{message_id:900,date:0,chat:{id:chatId,type:'supergroup' as const},from:app.bot.botInfo,text:'Online'}},
      ]) await app.update({message_thread_id:threadId,...update});
      assert.equal(probes,0);
      assert.equal(worktrees,0);
      assert.equal(app.topicEdits.length,edits);
      assert.equal(app.connectionCount,0);
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });
}

for (const origin of ['status', 'empty', 'session'] as const) {
  for (const command of ['new', 'attach'] as const) {
    test(`/${command} from a ${origin} detached topic creates a separate topic`, async () => {
      const app = await createSmokeApp();
      try {
        await app.update({text:'/setup'});
        if (origin === 'status') await app.service.sendStatusNotice(chatId,'Online');
        const threadId = origin === 'status' ? app.store.getBotStatusTopic(botId,chatId)! : 42;
        if (origin === 'session') await app.update({message_thread_id:threadId,forum_topic_created:{name:'Conversation history'}});
        const original = app.store.listSessions(botId)[0];
        if (origin !== 'status') await app.update({message_thread_id:threadId,text:'/detach'});
        const edits = app.topicEdits.filter(edit => edit.message_thread_id === threadId).length;
        await app.update({message_thread_id:threadId,text:command === 'new' ? '/new Separate task' : '/attach existing-host Separate history'});
        const separate = app.store.listSessions(botId).find(session => session.threadId !== threadId);
        assert.ok(separate);
        assert.equal(separate.status,'open');
        assert.equal(separate.runtime.kind,command === 'new' ? 'managed' : 'attached');
        assert.equal(app.store.getTopicKind({botId,chatId,threadId}),'detached');
        assert.equal(app.topicEdits.filter(edit => edit.message_thread_id === threadId).length,edits);
        if (original) {
          assert.equal(app.store.getSession(original.id)?.status,'detached');
          assert.equal(app.store.getSession(original.id)?.name,'Conversation history');
        } else {
          assert.equal(app.store.getTopic({botId,destination:{kind:'topic',chatId,threadId}}),undefined);
        }
      } finally { await app.close(); }
    });
  }
}

test('explicit detached topic identities ignore lifecycle updates and prompts without runtime or rename effects', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    app.store.detachTopic({botId,chatId,threadId:42});
    let probes = 0;
    app.runtime.topicTitleStatus = async () => { probes++; return {worktree:true,branch:'must-not-appear'}; };
    const before = app.topicEdits.length;
    for (const update of [
      {forum_topic_created:{name:'Detached topic'}},
      {forum_topic_edited:{name:'Human title'}},
      {forum_topic_closed:{}},
      {forum_topic_reopened:{}},
      {text:'/p Must not prompt'},
      {text:'Ordinary detached input'},
    ]) await app.update({message_thread_id:42,...update});
    assert.equal(probes,0);
    assert.equal(app.topicEdits.length,before);
    assert.equal(app.connectionCount,0);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('legacy status sessions are excluded from initialization, mirroring, and topic updates', async () => {
  const app = await createSmokeApp();
  let restarted: BotService | undefined;
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    const session = app.store.createSession({botId,chatId,threadId:42,instancePath},'Legacy status history');
    app.store.db.prepare('INSERT INTO bot_status_topics VALUES (?,?,?)').run(botId,chatId,42);
    let probes = 0;
    app.runtime.topicTitleStatus = async () => { probes++; return {worktree:true,branch:'must-not-appear'}; };
    const before = app.topicEdits.length;
    restarted = createBot({
      config:app.config,botConfig:app.config.bots[0]!,token:app.config.bots[0]!.token,
      store:app.store,runtime:app.runtime,bot:app.bot,
      connect:async () => { throw new Error('Status topic must not connect'); },
    });
    await restarted.initialize();
    restarted.startBackground();
    await assert.rejects(restarted.ensureMirroring(session,{instanceId:'fixture',sessionId:session.id,generation:0,url:'ws://fixture.invalid'}));
    await app.update({message_thread_id:42,forum_topic_created:{name:'Bot status'}});
    await app.update({message_thread_id:42,forum_topic_edited:{name:'Human status title'}});
    await app.update({message_thread_id:42,forum_topic_reopened:{}});
    await app.update({message_thread_id:42,text:'/p Must not prompt'});
    await delay(30);
    assert.equal(probes,0);
    assert.equal(app.topicEdits.length,before);
    assert.equal(app.connectionCount,0);
    assert.deepEqual(app.accepted,[]);
    assert.equal(app.store.getSession(session.id)?.name,'Legacy status history');
  } finally { await restarted?.close(); await app.close(); }
});

test('conversion to a status topic during a queued branch probe prevents Telegram renaming', async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preserved topic'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    await eventually(() =>
      app.topicEdits.some(edit =>
        edit.message_thread_id === session.threadId && edit.name === 'Preserved topic',
      ),
    );
    app.runtime.topicTitleStatus = async () => {
      entered.resolve();
      await release.promise;
      return {worktree:true,branch:'feature/must-not-rename'};
    };
    app.emit({t:'state',state:{cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]}});
    await entered.promise;
    app.store.setBotStatusTopic(botId,chatId,session.threadId);
    const before = app.topicEdits.filter(edit => 'name' in edit);
    release.resolve();
    await delay(50);
    assert.deepEqual(app.topicEdits.filter(edit => 'name' in edit),before);
    assert.equal(app.store.getSession(session.id)?.status,'detached');
    assert.equal(app.store.getTopicTitlePrefix(session.id),undefined);
  } finally { release.resolve(); await app.close(); }
});
