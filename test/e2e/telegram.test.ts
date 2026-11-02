import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { setupTelegramTest } from './helpers/telegram-fixture.js';
import { clickPanel, enrollForum, openPanel, sendImageDocument } from './helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, taskInput, writeScenario } from './helpers/model-tasks.js';

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
  const tasks = {
    initial: createWriteTask('initial', '\n/home/example/project/error.ts:27\n  throw new Error("Original diagnostic");\n    at run (/home/example/project/error.ts:27:11)\n/stop /unknown'),
    followup: createWriteTask('followup', '\nPreserve this second line.'),
    general: createWriteTask('general'),
    image: createWriteTask('image'),
    explicitImage: createWriteTask('explicit-image'),
  };
  const app = await setupCollaborationTest(t, { scenarios: Object.values(tasks).map(writeScenario) });
  const savedChat = () => readConfig(app.config.configPath).instances[app.omp.workspace]!.chats[0]!;
  await enrollForum(app);
  const settings = await openPanel(app, '/settings');
  for (const [index, key] of [[0, 'all_messages_are_prompts'], [1, 'users_can_propose_prompts'], [5, 'create_topic_worktrees']] as const) {
    const original = savedChat()[key];
    await clickPanel(app, settings, index);
    await app.waitForCondition(() => savedChat()[key] === !original);
    await clickPanel(app, settings, index);
    await app.waitForCondition(() => savedChat()[key] === original);
  }
  await clickPanel(app, settings, -1);
  assert.deepEqual(app.store.listSessions(app.telegram.bot.id), []);
  await app.waitForCondition(() => app.store.getSkillCatalog(app.omp.workspace)?.some(skill => skill.name === 'e2e-review') ?? false);

  const sent = await app.send(`/new ${tasks.initial.prompt}`);
  const reply = await completeWriteTask(app, tasks.initial, sent);
  await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
  const sessions = app.store.listSessions(app.telegram.bot.id);
  assert.equal(sessions.length, 1);
  const session = sessions[0]!;
  assert.equal(session.chatId, app.telegram.forum.chatId);
  assert.equal(session.instancePath, app.omp.workspace);
  assert.equal(session.runtime.kind, 'managed');
  assert.equal(session.status, 'open');
  assert.equal(app.store.hasPendingInitialTask(session.id), false);
  assert.equal(reply.replyToMessage?.threadId, session.threadId);
  assert.equal(app.omp.provider.requests.get(tasks.initial.name)![1]!.model, 'e2e-model');
  const history: SessionEntry[] = (await readFile(join(app.omp.dataDir, 'sessions', session.id, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === tasks.initial.toolCallId && entry.message.toolName === 'write' && !entry.message.isError));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.model === 'e2e-model' && entry.message.stopReason === 'stop'));

  await app.send('/unrecognized command', session.threadId);
  const skillKey = { botId: app.telegram.bot.id, destination: { kind: 'topic' as const, chatId: session.chatId, threadId: session.threadId }, userId: app.telegram.user.account.id };
  const skillPicker = await openPanel(app, '/skills', session.threadId);
  await clickPanel(app, skillPicker, 0);
  await clickPanel(app, skillPicker, 0);
  await app.send('/skill_e2e_review', session.threadId);
  await app.waitForCondition(() => app.store.getPendingSkills(skillKey).includes('e2e-review'));
  assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-review']);
  const generalPicker = await openPanel(app, '/skills');
  await clickPanel(app, generalPicker, 0);
  const generalSkillKey = { ...skillKey, destination: { kind: 'general' as const, chatId: session.chatId } };
  await app.waitForCondition(() => app.store.getPendingSkills(generalSkillKey).includes('e2e-review'));
  await app.send('/skills clear');
  await app.waitForCondition(() => app.store.getPendingSkills(generalSkillKey).length === 0);
  assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-review']);
  const followup = await app.send(tasks.followup.prompt, session.threadId);
  const followupReply = await completeWriteTask(app, tasks.followup, followup, session.threadId);
  assert.equal(followupReply.replyToMessage?.id, followup.id);
  assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(value => value.id), [session.id]);
  assert.deepEqual(app.store.getPendingSkills(skillKey), []);
  assert.ok(taskInput(app.omp.provider, tasks.followup).text.includes(`/skill:e2e-review\n\n${tasks.followup.prompt}`));

  await app.send('/skill_e2e_review');
  await app.waitForCondition(() => app.store.getPendingSkills(generalSkillKey).includes('e2e-review'));
  const general = await app.send(tasks.general.prompt);
  const generalReply = await completeWriteTask(app, tasks.general, general);
  const allSessions = app.store.listSessions(app.telegram.bot.id);
  const created = allSessions.find(value => value.id !== session.id)!;
  assert.equal(allSessions.length, 2);
  assert.notEqual(created.threadId, session.threadId);
  assert.notEqual(created.threadId, 1);
  assert.equal(generalReply.replyToMessage?.threadId, created.threadId);
  assert.equal(app.store.getTopic({ botId: app.telegram.bot.id, destination: { kind: 'general', chatId: session.chatId } }), undefined);
  assert.equal(app.store.hasPendingInitialTask(created.id), false);
  assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
  assert.ok(taskInput(app.omp.provider, tasks.general).text.includes(`/skill:e2e-review\n\n${tasks.general.prompt}`));

  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  for (const task of [tasks.image, tasks.explicitImage]) {
    const explicit = task === tasks.explicitImage;
    if (explicit) {
      const explicitSettings = await openPanel(app, '/settings', session.threadId);
      await clickPanel(app, explicitSettings, 0);
      await app.waitForCondition(() => savedChat().all_messages_are_prompts === false);
      await sendImageDocument(app, session.threadId, 'Ignored image discussion', imageBase64);
    }
    const caption = explicit ? `/p@${app.telegram.bot.username} ${task.prompt}` : task.prompt;
    const uploaded = await sendImageDocument(app, session.threadId, caption, imageBase64);
    await completeWriteTask(app, task, uploaded, session.threadId);
    assert.deepEqual(taskInput(app.omp.provider, task).images, [`data:image/png;base64,${imageBase64}`]);
    assert.ok(!taskInput(app.omp.provider, task).text.includes('/skill:e2e-review'));
  }

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
    reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({ copy_text: z.object({ text: z.string() }).optional() }))) }),
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
    if (scope.type === 'chat') assert.ok(commands.some(command => command.command === 'skill_e2e_review'));
  }
  const localIds = new Set(localCommands.map(message => message.id));
  assert.ok(!app.apiCalls.some(call => call.method === 'setMessageReaction' &&
    call.payload !== null && typeof call.payload === 'object' && 'message_id' in call.payload && localIds.has(Number(call.payload.message_id))));
  app.omp.provider.assertComplete();
});
