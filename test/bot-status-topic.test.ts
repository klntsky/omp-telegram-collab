import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId } from './telegram-data.js';

test('status notices create and reuse a reserved topic without creating a session', async () => {
  const app = await createSmokeApp();
  try {
    assert.equal(app.store.getBotStatusTopic(botId, chatId), undefined);
    await app.service.sendStatusNotice(chatId, 'Online');
    const threadId = app.store.getBotStatusTopic(botId, chatId);
    assert.ok(threadId);
    assert.deepEqual(app.createdTopics.map(topic => topic.name), ['Bot status']);
    await app.service.sendStatusNotice(chatId, 'Winding down');
    assert.equal(app.createdTopics.length, 1);
    assert.deepEqual(app.messages.map(message => ({ text: message.text, thread: message.message_thread_id })), [
      { text: 'Online', thread: threadId },
      { text: 'Winding down', thread: threadId },
    ]);
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
    assert.deepEqual(app.createdTopics.map(topic => topic.name), ['Bot status']);
    assert.equal(app.messages.at(-1)?.text, 'Replacement topic');
    assert.equal(app.messages.at(-1)?.message_thread_id, replacement);
    await app.service.sendStatusNotice(chatId, 'Reuse replacement');
    assert.equal(app.createdTopics.length, 1);
    assert.equal(app.messages.at(-1)?.message_thread_id, replacement);
    assert.deepEqual(app.store.listSessions(botId), []);
  } finally { await app.close(); }
});

for (const text of ['/terminate', '/setup', '/new Do not launch', '/p Do not prompt', '/status', '/help', '/kill', '/stop', '/new@FixtureOmpBot Do not launch', 'Do not treat this as a prompt']) {
  test(`reserved status topic ignores ${JSON.stringify(text)} before command and prompt effects`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({ text: '/setup' });
      await app.service.sendStatusNotice(chatId, 'Online');
      const threadId = app.store.getBotStatusTopic(botId, chatId)!;
      const before = { messages: app.messages.length, reactions: app.reactions.length, topics: app.createdTopics.length, config: JSON.stringify(app.config) };
      await app.update({ message_thread_id: threadId, forum_topic_created: { name: 'Bot status' } });
      await app.update({ message_thread_id: threadId, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}) });
      await app.update({ message_thread_id: threadId, text: 'Reply must not prompt', reply_to_message: { message_id: 900, date: 0, chat: { id: chatId, type: 'supergroup' }, from: app.bot.botInfo, text: 'Online' } });
      assert.equal(app.messages.length, before.messages);
      assert.equal(app.reactions.length, before.reactions);
      assert.equal(app.createdTopics.length, before.topics);
      assert.equal(JSON.stringify(app.config), before.config);
      assert.deepEqual(app.store.listSessions(botId), []);
      assert.deepEqual(app.accepted, []);
      assert.equal(app.connectionCount, 0);
    } finally { await app.close(); }
  });
}
