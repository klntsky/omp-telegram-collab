import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { z } from 'zod';
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

test('Telegram tasks create and reuse real OMP sessions while idle commands leave hosts stopped', { timeout: 360000 }, async t => {
  const evidence = { executedBy: 'real-omp-write-tool', nonce: randomUUID() };
  const followupEvidence = { ...evidence, nonce: randomUUID() };
  const generalEvidence = { ...evidence, nonce: randomUUID() };
  const prompt = `Create e2e-result.json in the workspace containing ${JSON.stringify(evidence)}.\n/home/example/project/error.ts:27\n  throw new Error("Original diagnostic");\n    at run (/home/example/project/error.ts:27:11)\n/stop /unknown`;
  const followupPrompt = `Write e2e-followup.json containing ${JSON.stringify(followupEvidence)}.\nPreserve this second line.`;
  const generalPrompt = `Write e2e-general.json containing ${JSON.stringify(generalEvidence)}.`;
  const app = await setupCollaborationTest(t, { scenarios: [
    { name: 'initial', prompt, steps: [
      { type: 'tool', id: 'call_e2e_write', name: 'write', arguments: { i: 'Writing E2E evidence', path: 'e2e-result.json', content: `${JSON.stringify(evidence)}\n` } },
      { type: 'text', text: 'The requested file has been written.' },
    ] },
    { name: 'followup', prompt: followupPrompt, steps: [
      { type: 'tool', id: 'call_e2e_followup', name: 'write', arguments: { i: 'Writing followup evidence', path: 'e2e-followup.json', content: JSON.stringify(followupEvidence) } },
      { type: 'text', text: 'The followup file has been written.' },
    ] },
    { name: 'general', prompt: generalPrompt, steps: [
      { type: 'tool', id: 'call_e2e_general', name: 'write', arguments: { i: 'Writing General evidence', path: 'e2e-general.json', content: JSON.stringify(generalEvidence) } },
      { type: 'text', text: 'The General task file has been written.' },
    ] },
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

  const initialRequests = app.omp.provider.requests.get('initial')!;
  assert.equal(initialRequests.length, 2);
  const continuation = initialRequests[1]!;
  assert.equal(continuation.model, 'e2e-model');
  const messages = continuation.messages as { role: string; tool_call_id?: string }[];
  assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_e2e_write'));

  const history: SessionEntry[] = (await readFile(join(app.omp.dataDir, 'sessions', session.id, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === 'call_e2e_write' && entry.message.toolName === 'write' && !entry.message.isError));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.model === 'e2e-model' && entry.message.stopReason === 'stop'));

  await app.send('/unrecognized command', session.threadId);
  const followup = await app.send(followupPrompt, session.threadId);
  const followupReply = await app.waitForReply({ replyToMessageId: followup.id, threadId: session.threadId });
  assert.equal(followupReply.replyToMessage?.id, followup.id);
  assert.deepEqual(JSON.parse(await readFile(join(app.omp.workspace, 'e2e-followup.json'), 'utf8')), followupEvidence);
  assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(value => value.id), [session.id]);
  assert.equal(app.omp.provider.requests.get('followup')!.length, 2);

  const general = await app.send(generalPrompt);
  const generalReply = await app.waitForReply({ replyToMessageId: general.id });
  const allSessions = app.store.listSessions(app.telegram.bot.id);
  const created = allSessions.find(value => value.id !== session.id)!;
  assert.equal(allSessions.length, 2);
  assert.notEqual(created.threadId, session.threadId);
  assert.notEqual(created.threadId, 1);
  assert.equal(generalReply.replyToMessage?.threadId, created.threadId);
  assert.equal(app.store.getTopic({ botId: app.telegram.bot.id, destination: { kind: 'general', chatId: session.chatId } }), undefined);
  assert.equal(app.store.hasPendingInitialTask(created.id), false);
  assert.deepEqual(JSON.parse(await readFile(join(app.omp.workspace, 'e2e-general.json'), 'utf8')), generalEvidence);
  assert.equal(app.omp.provider.requests.get('general')!.length, 2);

  const idleTopic = await app.telegram.user.client.createForumTopic({ chatId: app.telegram.forum.chat, title: 'Idle command checks' });
  const idleThreadId = idleTopic.id;
  await app.waitForCondition(() => app.store.listSessions(app.telegram.bot.id).some(value => value.threadId === idleThreadId));
  const idleSession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === idleThreadId)!;
  await app.send('/stop', idleThreadId);
  const localCommands = [];
  for (const command of ['/help', '/status', '/skills', '/settings', '/cli']) {
    localCommands.push(await app.send(command, idleThreadId));
  }
  const copyPayload = z.object({
    message_thread_id: z.literal(idleThreadId),
    reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({
      copy_text: z.object({ text: z.string() }).optional(),
    }))) }),
  });
  const expectedCommand = `omp-telegram-collab session join --chat ${session.chatId} --topic ${idleThreadId}`;
  await app.waitForCondition(() => app.apiCalls.some(call => {
    if (call.method !== 'sendMessage') return false;
    const parsed = copyPayload.safeParse(call.payload);
    return parsed.success && parsed.data.reply_markup.inline_keyboard.flat().some(button => button.copy_text?.text === expectedCommand);
  }));
  assert.equal(await app.runtime.isRunning(idleSession), false);
  const adminCommands = await app.telegram.api.getMyCommands({ scope: { type: 'chat_administrators', chat_id: session.chatId } });
  assert.ok(adminCommands.some(command => command.command === 'cli'));
  for (const scope of [{ type: 'all_group_chats' as const }, { type: 'chat' as const, chat_id: session.chatId }]) {
    const commands = await app.telegram.api.getMyCommands({ scope });
    assert.ok(!commands.some(command => command.command === 'cli' || command.command === 'session'));
    assert.ok(commands.some(command => command.command === 'p'));
  }
  const localIds = new Set(localCommands.map(message => message.id));
  assert.ok(!app.apiCalls.some(call => call.method === 'setMessageReaction' &&
    call.payload !== null && typeof call.payload === 'object' && 'message_id' in call.payload && localIds.has(Number(call.payload.message_id))));
  app.omp.provider.assertComplete();
});
