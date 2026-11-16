import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { readConfig, writeConfig } from '../../src/config.js';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from './helpers/telegram-actions.js';
import { createTelegramTestForum } from './helpers/telegram-resources.js';
import { completeWriteTask, createWriteTask, writeScenario } from './helpers/model-tasks.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../scripts/lib/telegram-test-deadline.js';

const observedCall = z.object({
  method: z.string(),
  payload: z.object({
    chat_id: z.number().optional(),
    scope: z.object({ chat_id: z.number().optional() }).optional(),
  }),
  result: z.object({ ok: z.boolean() }),
});

// Telegram implements forum deletion through channels.deleteChannel, not a
// synthetic Bot API update.
// https://github.com/tdlib/td/blob/master/td/telegram/ChatManager.cpp (DeleteChannelQuery)
test('a deleted assigned forum cannot prevent another forum from restarting and executing tasks', { timeout: 300000 }, async t => {
  const task = createWriteTask('chat-isolation');
  const app = await setupCollaborationTest(t, { scenarios: [writeScenario(task)] });
  await enrollForum(app);
  const healthy = await createManagedTopic(app);
  const removed = await withTelegramTestDeadline('secondary forum provisioning', telegramTestTimeouts.provision, t.signal,
    signal => createTelegramTestForum(app.telegram.user, app.telegram.bot, { signal }));
  t.after(() => removed.close());
  const topic = await app.telegram.api.createForumTopic(removed.chatId, 'Deleted forum session');
  const entry = await app.telegram.api.sendMessage(removed.chatId, 'Session entry', {
    message_thread_id: topic.message_thread_id,
    reply_markup: { inline_keyboard: [[{ text: 'Session', url: 'https://example.com' }]] },
  });
  app.store.enrollGroup(app.telegram.bot.id, removed.chatId);
  const orphan = app.store.createSession({
    botId: app.telegram.bot.id, chatId: removed.chatId, threadId: topic.message_thread_id,
    instanceId: 1, cwd: app.omp.workspace,
  }, 'Deleted forum session');
  app.store.setSessionEntry(orphan.id, entry.message_id, 'stale');
  const healthyEntry = app.store.getSessionEntry(healthy.id)!;
  app.store.setSessionEntry(healthy.id, healthyEntry.messageId, 'stale');
  const config = readConfig(app.config.configPath);
  config.instances[0]!.chats.unshift({ botId: app.telegram.bot.id, chatId: removed.chatId });
  writeConfig(config);
  await removed.close();
  const start = app.apiCalls.length;
  await app.restart();
  const calls = z.array(observedCall).parse(app.apiCalls.slice(start));
  const failed = calls.find(call => call.method === 'editMessageReplyMarkup' &&
    call.payload.chat_id === removed.chatId);
  assert.ok(failed, 'startup must attempt the retained entry in the deleted forum');
  assert.equal(failed.result.ok, false);
  assert.notEqual(app.store.getSessionEntry(orphan.id)?.markup, JSON.stringify({ inline_keyboard: [] }));
  assert.equal(app.store.getSessionEntry(healthy.id)?.markup, JSON.stringify({ inline_keyboard: [] }));
  assert.ok(calls.some(call => call.method === 'setMyCommands' &&
    call.payload.scope?.chat_id === app.telegram.forum.chatId && call.result.ok));
  await app.sendAndWait('/modelpreset nonexistent-chat-isolation-preset', healthy.threadId);
  const sent = await app.sendAndWait(`/p ${task.prompt}`, healthy.threadId);
  await completeWriteTask(app, task, sent, healthy.threadId);
  assert.equal(app.store.getSession(orphan.id)?.status, 'open');
});
