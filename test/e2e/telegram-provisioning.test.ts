import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTelegramTest } from './helpers/telegram-fixture.js';

test('test user provisions a bot and forum with usable topic permissions', { timeout: 180000 }, async t => {
  const { user, bot, api, forum, inbox } = await setupTelegramTest(t);
  const [me, chat, member] = await Promise.all([
    api.getMe(), api.getChat(forum.chatId), api.getChatMember(forum.chatId, bot.id),
  ]);
  assert.equal(me.id, bot.id);
  assert.equal(chat.type, 'supergroup');
  assert.ok('is_forum' in chat && chat.is_forum);
  assert.equal(member.status, 'administrator');
  assert.ok('can_manage_topics' in member && member.can_manage_topics);
  assert.ok('can_pin_messages' in member && member.can_pin_messages);

  const topic = await api.createForumTopic(forum.chatId, 'Protocol check');
  const sent = await user.client.sendText(forum.chat, '/start', { threadId: topic.message_thread_id });
  const update = await inbox.waitFor(candidate => candidate.message?.chat.id === forum.chatId && candidate.message.message_id === sent.id);
  assert.equal(update.message?.from?.id, user.account.id);
  assert.equal(update.message?.message_thread_id, topic.message_thread_id);
  assert.equal(update.message?.is_topic_message, true);
  assert.ok(update.message?.entities?.some(entity => entity.type === 'bot_command' && entity.offset === 0 && entity.length === 6));
});
