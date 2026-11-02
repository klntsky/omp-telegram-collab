import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
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

test('userbot task reaches real omp, executes a streamed tool call, and receives the completion in Telegram', { timeout: 240000 }, async t => {
  const evidence = { executedBy: 'real-omp-write-tool', nonce: randomUUID() };
  const prompt = `Create e2e-result.json in the workspace containing ${JSON.stringify(evidence)}.\n/home/example/project/error.ts:27\n  throw new Error("Original diagnostic");\n    at run (/home/example/project/error.ts:27:11)\n/stop /unknown`;
  const app = await setupCollaborationTest(t, { steps: [
    { type: 'tool', id: 'call_e2e_write', name: 'write', arguments: { i: 'Writing E2E evidence', path: 'e2e-result.json', content: `${JSON.stringify(evidence)}\n` } },
    { type: 'text', text: 'The requested file has been written.' },
  ] });
  await app.omp.step('telegram.enroll', async () => {
    await app.send('/setup');
    await app.waitForCondition(() => app.store.isEnrolled(app.telegram.bot.id, app.telegram.forum.chatId));
  });
  const sent = await app.send(`/new ${prompt}`);
  const reply = await app.omp.step('telegram.await-completion', () => app.waitForReply({ replyToMessageId: sent.id }));
  await app.omp.step('omp.await-agent-end', () => app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end')));

  const sessions = app.store.listSessions(app.telegram.bot.id);
  assert.equal(sessions.length, 1);
  const session = sessions[0]!;
  assert.equal(session.chatId, app.telegram.forum.chatId);
  assert.equal(session.instancePath, app.omp.workspace);
  assert.equal(session.runtime.kind, 'managed');
  assert.equal(session.status, 'open');
  assert.equal(app.store.hasPendingInitialTask(session.id), false);
  assert.equal(reply.chat.id, session.chatId);
  assert.equal(reply.sender.id, app.telegram.bot.id);
  assert.equal(reply.replyToMessage?.threadId, session.threadId);
  assert.deepEqual(JSON.parse(await readFile(join(app.omp.workspace, 'e2e-result.json'), 'utf8')), evidence);

  app.omp.provider.assertComplete();
  assert.ok(JSON.stringify(app.omp.provider.requests[0]!.messages).includes(JSON.stringify(prompt).slice(1, -1)));
  const continuation = app.omp.provider.requests[1]!;
  assert.equal(continuation.model, 'e2e-model');
  const messages = continuation.messages as { role: string; tool_call_id?: string }[];
  assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_e2e_write'));

  const history: SessionEntry[] = (await readFile(join(app.omp.dataDir, 'sessions', session.id, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === 'call_e2e_write' && entry.message.toolName === 'write' && !entry.message.isError));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.model === 'e2e-model' && entry.message.stopReason === 'stop'));
});
