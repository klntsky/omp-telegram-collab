import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { createBot, type BotService } from '../src/bot.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, botToken, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

const stoppedIcon = '5408906741125490282';

test('restart skips unchanged icons and retains a later human finish icon on reopening', async () => {
  const app = await createSmokeApp();
  let restarted: BotService | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Persisted icon'}});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.getTopicIcon(session.id),stoppedIcon);
    await app.service.close();
    const before = app.topicEdits.length;
    restarted = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,
      bot:new Bot(botToken,{client:{apiRoot:app.telegramUrl}}),telegramIntervalMs:0});
    await restarted.initialize();
    restarted.startBackground();
    const chat = {id:chatId,type:'supergroup',title:'Fixture project',is_forum:true} as const;
    const from = {id:ownerId,is_bot:false,first_name:'Ada',username:ownerUsername};
    await restarted.bot.handleUpdate({update_id:9001,message:{message_id:9001,date:0,chat,from,message_thread_id:42,forum_topic_reopened:{}}});
    assert.equal(app.topicEdits.length,before,'an unchanged cached icon must not be rewritten on restart');
    await restarted.bot.handleUpdate({update_id:9002,message:{message_id:9002,date:0,chat,from,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'human-selected-icon'}}});
    assert.equal(app.store.getTopicIcon(session.id),'human-selected-icon');
    assert.equal(app.store.getTopicFinishIcon(session.id),'human-selected-icon');
    await restarted.bot.handleUpdate({update_id:9003,message:{message_id:9003,date:0,chat,from,message_thread_id:42,forum_topic_reopened:{}}});
    assert.equal(app.topicEdits.length,before,'reopening preserves the human icon without a redundant projection');
    assert.equal(app.store.getTopicIcon(session.id),'human-selected-icon');
  } finally { await restarted?.close(); await app.close(); }
});

test('a rate-limited icon change is retained and only confirmed state is persisted', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    app.rateLimitNext('editForumTopic');
    await app.update({message_thread_id:42,forum_topic_created:{name:'Rate-limited icon'}});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.getTopicIcon(session.id),stoppedIcon);
    assert.deepEqual(app.topicEdits.map(edit => edit.icon_custom_emoji_id),[stoppedIcon]);
  } finally { await app.close(); }
});

for (const stage of ['running','idle live','stopped'] as const) {
  for (const preference of ['human-selected-icon','','5312016608254762256','5408906741125490282','5237699328843200968']) {
    test(`human finish icon ${JSON.stringify(preference)} selected while ${stage} survives running and bot echoes`, async () => {
      const app = await createSmokeApp();
      const runningIcon = '5312016608254762256';
      const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
      try {
        await app.update({text:'/setup'});
        await app.update({message_thread_id:42,forum_topic_created:{name:'Human finish icon'}});
        const session = app.store.listSessions(botId)[0]!;
        if (stage !== 'stopped') {
          await app.service.ensureMirroring(session,await app.runtime.ensure(session));
          if (stage === 'running') {
            app.emit({t:'event',event:{type:'agent_start'}});
            await eventually(() => app.store.getTopicIcon(session.id) === runningIcon);
          } else {
            assert.equal(await app.runtime.isRunning(session),true);
          }
        }
        await app.update({message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:preference}});
        assert.equal(app.store.getTopicFinishIcon(session.id),preference);
        await eventually(() => app.store.getTopicIcon(session.id) === (stage === 'running' ? runningIcon : preference));
        const ownBot = {id:botId,first_name:'OMP',is_bot:true};
        for (const echo of [stoppedIcon,runningIcon,'']) {
          await app.update({message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:echo}},ownBot);
          assert.equal(app.store.getTopicFinishIcon(session.id),preference,'bot echoes cannot replace human intent');
        }
        if (stage === 'stopped') {
          assert.equal(app.connectionCount,0,'choosing an icon does not launch a host');
          await app.service.ensureMirroring(session,await app.runtime.ensure(session));
        }
        app.emit({t:'event',event:{type:'agent_start'}});
        await eventually(() => app.store.getTopicIcon(session.id) === runningIcon);
        assert.equal(app.store.getTopicFinishIcon(session.id),preference);
        app.emit({t:'state',state});
        await eventually(() => app.store.getTopicIcon(session.id) === preference);
        assert.equal(await app.runtime.isRunning(session),true,'idle live hosts use the finish preference');
        app.emit({t:'event',event:{type:'agent_start'}});
        await eventually(() => app.store.getTopicIcon(session.id) === runningIcon);
        await app.update({message_thread_id:42,text:'/kill'});
        assert.equal(await app.runtime.isRunning(session),false);
        await eventually(() => app.store.getTopicIcon(session.id) === preference);
        assert.equal(app.store.getTopicFinishIcon(session.id),preference);
      } finally { await app.close(); }
    });
  }
}
