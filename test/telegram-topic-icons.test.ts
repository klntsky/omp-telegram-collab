import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Telegraf } from 'telegraf';
import { createBot, type BotService } from '../src/bot.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, botToken, chatId, ownerId, ownerUsername } from './telegram-data.js';

const stoppedIcon = '5408906741125490282';

test('restart skips a confirmed unchanged icon and observes a later human icon change', async () => {
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
      bot:new Telegraf(botToken,{telegram:{apiRoot:app.telegramUrl}}),telegramIntervalMs:0});
    await restarted.initialize();
    const chat = {id:chatId,type:'supergroup',title:'Fixture project',is_forum:true} as const;
    const from = {id:ownerId,is_bot:false,first_name:'Ada',username:ownerUsername};
    await restarted.bot.handleUpdate({update_id:9001,message:{message_id:9001,date:0,chat,from,message_thread_id:42,forum_topic_reopened:{}}});
    assert.equal(app.topicEdits.length,before,'an unchanged cached icon must not be rewritten on restart');
    await restarted.bot.handleUpdate({update_id:9002,message:{message_id:9002,date:0,chat,from,message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'human-selected-icon'}}});
    assert.equal(app.store.getTopicIcon(session.id),'human-selected-icon');
    await restarted.bot.handleUpdate({update_id:9003,message:{message_id:9003,date:0,chat,from,message_thread_id:42,forum_topic_reopened:{}}});
    assert.equal(app.topicEdits.length,before+1,'a human change invalidates the old desired-state cache');
    assert.equal(app.topicEdits.at(-1)?.icon_custom_emoji_id,stoppedIcon);
    assert.equal(app.store.getTopicIcon(session.id),stoppedIcon);
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
