import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { createBot, type BotService } from '../src/bot.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, botToken, chatId, ownerId, ownerUsername } from './telegram-data.js';

test('human icon preferences persist across restart without redundant Telegram writes or bot-echo mutations', async () => {
  const app = await createSmokeApp();
  let restarted: BotService | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Persisted preference'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:'human-selected-icon'}});
    await app.service.close();
    const before = app.topicEdits.length;
    restarted = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,
      bot:new Bot(botToken,{client:{apiRoot:app.telegramUrl}})});
    await restarted.initialize();
    const chat = {id:chatId,type:'supergroup',title:'Fixture project',is_forum:true} as const;
    const from = {id:ownerId,is_bot:false,first_name:'Ada',username:ownerUsername};
    await restarted.bot.handleUpdate({update_id:9001,message:{message_id:9001,date:0,chat,from,message_thread_id:42,forum_topic_reopened:{}}});
    assert.equal(app.topicEdits.length,before);
    await restarted.bot.handleUpdate({update_id:9002,message:{message_id:9002,date:0,chat,from:{id:botId,is_bot:true,first_name:'OMP'},message_thread_id:42,forum_topic_edited:{icon_custom_emoji_id:''}}});
    assert.equal(app.store.getTopicFinishIcon(session.id),'human-selected-icon');
    assert.equal(app.connectionCount,0);
  } finally { await restarted?.close(); await app.close(); }
});
