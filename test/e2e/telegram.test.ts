import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { z } from 'zod';
import { readConfig, writeConfig } from '../../src/config.js';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { changeTopicClosed, clickPanel, enrollForum, openPanel, reactionAttempts, replyText, sendImageDocument, setTopicClosed, waitForEditor, waitForPanel, waitForReactionAttempt } from './helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, questionScenario, questionStep, readSessionHistory, taskInput, writeScenario } from './helpers/model-tasks.js';

test('Telegram workflows share one fixture across protocol, media, lifecycle, and restart checks', { timeout: 480000 }, async t => {
  const tasks = {
    initial: createWriteTask('initial', '\n/home/example/project/error.ts:27\n  throw new Error("Original diagnostic");\n    at run (/home/example/project/error.ts:27:11)\n/stop /unknown'),
    worktree: createWriteTask('worktree'),
    worktreeRestarted: createWriteTask('worktree-restarted'),
    question: createWriteTask('question'),
    customAnswer: createWriteTask('custom-answer'),
    askHandoff: createWriteTask('ask-handoff'),
    settingsReply: createWriteTask('settings-reply'),
    image: createWriteTask('image'),
    explicitImage: createWriteTask('explicit-image'),
    followup: createWriteTask('followup', '\nPreserve this second line.'),
    general: createWriteTask('general'),
    resumed: createWriteTask('resumed'),
    reopened: createWriteTask('reopened'),
    idle: createWriteTask('idle'),
    separate: createWriteTask('separate'),
    restarted: createWriteTask('restarted'),
    restored: createWriteTask('restored'),
  };
  const interrupted = { name: 'interrupted', prompt: `Wait for a stop command ${tasks.initial.evidence.nonce}` };
  const cancelledQuestion = { name: 'cancelled-question', prompt: `Ask before the next task ${tasks.initial.evidence.nonce}` };
  const scenarios = Object.values(tasks).map(task =>
    task === tasks.question || task === tasks.customAnswer ? questionScenario(task) : writeScenario(task));
  const app = await setupCollaborationTest(t, { scenarios: [
    ...scenarios,
    { ...interrupted, steps: [{ type: 'await-abort' }] },
    { ...cancelledQuestion, steps: [questionStep(cancelledQuestion.name)] },
  ] });
  const savedChat = () => readConfig(app.config.configPath).instances[app.omp.workspace]!.chats[0]!;
  const [me, chat, member] = await Promise.all([
    app.telegram.api.getMe(), app.telegram.api.getChat(app.telegram.forum.chatId),
    app.telegram.api.getChatMember(app.telegram.forum.chatId, app.telegram.bot.id),
  ]);
  assert.equal(me.id, app.telegram.bot.id);
  assert.equal(chat.type, 'supergroup');
  assert.ok('is_forum' in chat && chat.is_forum);
  assert.equal(member.status, 'administrator');
  assert.ok('can_manage_topics' in member && member.can_manage_topics);
  assert.ok('can_pin_messages' in member && member.can_pin_messages);

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

  const sent = await app.sendAndWait(`/new ${tasks.initial.prompt}`);
  const reply = await completeWriteTask(app, tasks.initial, sent);
  await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
  const sessions = app.store.listSessions(app.telegram.bot.id);
  assert.equal(sessions.length, 1);
  let session = sessions[0]!;
  assert.equal(session.chatId, app.telegram.forum.chatId);
  assert.equal(session.instancePath, app.omp.workspace);
  assert.equal(session.runtime.kind, 'managed');
  assert.equal(session.status, 'open');
  assert.equal(app.store.hasPendingInitialTask(session.id), false);
  assert.equal(reply.replyToMessage?.threadId, session.threadId);
  assert.equal(app.omp.provider.requests.get(tasks.initial.name)![1]!.model, 'e2e-model');
  const history: SessionEntry[] = (await readSessionHistory(app.omp.dataDir, session.id)).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === tasks.initial.toolCallId && entry.message.toolName === 'write' && !entry.message.isError));
  assert.ok(history.some(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.model === 'e2e-model' && entry.message.stopReason === 'stop'));

  await app.omp.git(app.omp.workspace, 'add', '--all');
  await app.omp.git(app.omp.workspace, 'commit', '-m', 'Preserve initial task evidence');
  await app.sendAndWait('/worktree e2e-branch', session.threadId);
  session = app.store.getSession(session.id)!;
  await app.omp.assertWorktree(session, 'e2e-branch');
  assert.equal(await app.omp.git(app.omp.workspace, 'branch', '--show-current'), 'main');
  const worktree = await app.sendAndWait(`/p ${tasks.worktree.prompt}`, session.threadId);
  await completeWriteTask(app, tasks.worktree, worktree, session.threadId);
  assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.worktree.name)![0]!.messages).includes(tasks.initial.evidence.nonce));
  await assert.rejects(readFile(join(app.omp.workspace, tasks.worktree.path), 'utf8'), { code: 'ENOENT' });
  const worktreeRuntime = session.runtime;
  await app.restart();
  session = app.store.getSession(session.id)!;
  assert.deepEqual(session.runtime, worktreeRuntime);
  const worktreeRestarted = await app.sendAndWait(`/p ${tasks.worktreeRestarted.prompt}`, session.threadId);
  await completeWriteTask(app, tasks.worktreeRestarted, worktreeRestarted, session.threadId);
  assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.worktreeRestarted.name)![0]!.messages).includes(tasks.worktree.evidence.nonce));

  const interruptedFrames = app.hostFrames.length;
  await app.sendAndWait(`/p ${interrupted.prompt}`, session.threadId);
  await app.omp.provider.waitForRequest(interrupted.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
  const activeStop = await app.sendAndWait('/stop', session.threadId);
  await app.omp.provider.waitForAbort(interrupted.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
  await waitForReactionAttempt(app, activeStop.id, '🤝');
  await app.waitForCondition(() => app.hostFrames.slice(interruptedFrames).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
  assert.equal(await app.runtime.isRunning(session), true);

  for (const task of [tasks.question, tasks.customAnswer]) {
    const start = app.apiCalls.length;
    const questionFrames = app.hostFrames.length;
    const instruction = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
    const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
    const select = app.hostFrames.slice(questionFrames).findLast(frame => frame.t === 'ui-request');
    assert.ok(select?.t === 'ui-request' && select.request.kind === 'select');
    if (task === tasks.question) {
      await replyText(app, panel.messageId, session.threadId, '/unknown Never treat this as an answer');
      assert.equal(app.omp.provider.requests.get(task.name)!.length, 1);
      await clickPanel(app, panel, 1);
      await completeWriteTask(app, task, instruction, session.threadId);
      assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === select.request.reqId && frame.value === 'Remote'));
    } else {
      const editorStart = app.apiCalls.length;
      await clickPanel(app, panel, 2);
      const editorMessageId = await waitForEditor(app, editorStart, session.threadId);
      const editor = app.hostFrames.findLast(frame => frame.t === 'ui-request');
      assert.ok(editor?.t === 'ui-request' && editor.request.kind === 'editor');
      await replyText(app, editorMessageId, session.threadId, '/unknown Never treat this command as an answer');
      const answer = 'Custom destination\n  Preserve <literal> **content** and whitespace';
      await replyText(app, editorMessageId, session.threadId, answer);
      await completeWriteTask(app, task, instruction, session.threadId);
      assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === editor.request.reqId && frame.value === answer));
    }
  }
  const handoffStart = app.apiCalls.length;
  await app.sendAndWait(`/p ${cancelledQuestion.prompt}`, session.threadId);
  const waitingQuestion = await waitForPanel(app, 'question', 'ask:', handoffStart, session.threadId);
  const handoffEditorStart = app.apiCalls.length;
  await clickPanel(app, waitingQuestion, 2);
  const handoffEditor = await waitForEditor(app, handoffEditorStart, session.threadId);
  const handoffText = `/p ${tasks.askHandoff.prompt}`;
  const handoff = await replyText(app, handoffEditor, session.threadId, handoffText);
  await completeWriteTask(app, tasks.askHandoff, handoff, session.threadId);
  assert.ok(!app.guestFrames.some(frame => frame.t === 'ui-response' && frame.value === handoffText));

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
    const input = taskInput(app.omp.provider, task);
    assert.deepEqual(input.images, [`data:image/png;base64,${imageBase64}`]);
    assert.ok(!input.text.includes('/skill:e2e-review'));
  }
  const promptSettings = await openPanel(app, '/settings', session.threadId);
  await replyText(app, promptSettings.messageId, session.threadId, '/unknown Not a setting or task');
  const settingsTask = await replyText(app, promptSettings.messageId, session.threadId, `/p ${tasks.settingsReply.prompt}`);
  await completeWriteTask(app, tasks.settingsReply, settingsTask, session.threadId);
  await clickPanel(app, promptSettings, 0);
  await app.waitForCondition(() => savedChat().all_messages_are_prompts === true);

  await app.waitForCondition(() => app.store.getSkillCatalog(app.omp.workspace)?.some(skill => skill.name === 'e2e-review') ?? false);
  await app.sendAndWait('/unrecognized command', session.threadId);
  const skillKey = { botId: app.telegram.bot.id, destination: { kind: 'topic' as const, chatId: session.chatId, threadId: session.threadId }, userId: app.telegram.user.account.id };
  const skillPicker = await openPanel(app, '/skills', session.threadId);
  await clickPanel(app, skillPicker, 0);
  await clickPanel(app, skillPicker, 0);
  await app.sendAndWait('/skill_e2e_review', session.threadId);
  assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-review']);
  const generalPicker = await openPanel(app, '/skills');
  await clickPanel(app, generalPicker, 0);
  const generalSkillKey = { ...skillKey, destination: { kind: 'general' as const, chatId: session.chatId } };
  await app.waitForCondition(() => app.store.getPendingSkills(generalSkillKey).includes('e2e-review'));
  await app.sendAndWait('/skills clear');
  assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
  assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-review']);
  const followup = await app.sendAndWait(tasks.followup.prompt, session.threadId);
  const followupReply = await completeWriteTask(app, tasks.followup, followup, session.threadId);
  assert.equal(followupReply.replyToMessage?.id, followup.id);
  assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(value => value.id), [session.id]);
  assert.deepEqual(app.store.getPendingSkills(skillKey), []);
  assert.ok(taskInput(app.omp.provider, tasks.followup).text.includes(`/skill:e2e-review\n\n${tasks.followup.prompt}`));

  const selectedDirectory = join(app.omp.workspace, 'selected');
  await mkdir(selectedDirectory);
  app.setFolderOptions(['.', 'selected']);
  await app.sendAndWait('/skill_e2e_review');
  const folderStart = app.apiCalls.length;
  const general = await app.sendAndWait(tasks.general.prompt);
  const folders = await waitForPanel(app, 'folder', 'folder:', folderStart);
  assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), [session.id]);
  assert.deepEqual(app.store.getPendingSkills(generalSkillKey), ['e2e-review']);
  await clickPanel(app, folders, 1);
  const generalReply = await completeWriteTask(app, tasks.general, general);
  const allSessions = app.store.listSessions(app.telegram.bot.id);
  const created = allSessions.find(value => value.id !== session.id)!;
  assert.equal(allSessions.length, 2);
  assert.deepEqual(created.runtime, { kind: 'managed', cwd: selectedDirectory });
  assert.equal(created.instancePath, app.omp.workspace);
  await assert.rejects(readFile(join(app.omp.workspace, tasks.general.path), 'utf8'), { code: 'ENOENT' });
  app.setFolderOptions([]);
  assert.notEqual(created.threadId, session.threadId);
  assert.notEqual(created.threadId, 1);
  assert.equal(generalReply.replyToMessage?.threadId, created.threadId);
  assert.equal(app.store.getTopic({ botId: app.telegram.bot.id, destination: { kind: 'general', chatId: session.chatId } }), undefined);
  assert.equal(app.store.hasPendingInitialTask(created.id), false);
  assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
  assert.ok(taskInput(app.omp.provider, tasks.general).text.includes(`/skill:e2e-review\n\n${tasks.general.prompt}`));

  const historyBeforeKill = await readSessionHistory(app.omp.dataDir, session.id);
  const kill = await app.sendAndWait('/kill', session.threadId);
  await waitForReactionAttempt(app, kill.id, '🤝');
  assert.deepEqual(reactionAttempts(app, kill.id), [['👀'], ['🤝']]);
  assert.equal(await app.runtime.isRunning(session), false);
  assert.equal(await app.runtime.isRunning(created), true);
  assert.ok((await readSessionHistory(app.omp.dataDir, session.id)).startsWith(historyBeforeKill));
  const resumed = await app.sendAndWait(`/p ${tasks.resumed.prompt}`, session.threadId);
  await completeWriteTask(app, tasks.resumed, resumed, session.threadId);
  assert.equal(app.store.getSession(session.id)?.id, session.id);
  assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.resumed.name)![0]!.messages).includes(tasks.initial.evidence.nonce));
  await setTopicClosed(app, session, true);
  await setTopicClosed(app, session, false);
  const reopened = await app.sendAndWait(`/p ${tasks.reopened.prompt}`, session.threadId);
  await completeWriteTask(app, tasks.reopened, reopened, session.threadId);
  assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.reopened.name)![0]!.messages).includes(tasks.resumed.evidence.nonce));
  await setTopicClosed(app, created, true);

  await app.omp.git(app.omp.workspace, 'add', '--all');
  await app.omp.git(app.omp.workspace, 'commit', '-m', 'Preserve selected-folder task evidence');
  const manualWorktrees = await openPanel(app, '/settings');
  await clickPanel(app, manualWorktrees, 5);
  await app.waitForCondition(() => savedChat().create_topic_worktrees === true);
  const requestsBeforeManualTopic = Array.from(app.omp.provider.requests, ([name, requests]) => [name, requests.length]);
  const idleTopic = await app.telegram.user.client.createForumTopic({ chatId: app.telegram.forum.chat, title: 'Idle command checks' });
  const idleThreadId = idleTopic.id;
  await app.waitForMessageHandled(idleThreadId);
  const idleSession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === idleThreadId)!;
  await app.omp.assertWorktree(idleSession);
  assert.deepEqual(Array.from(app.omp.provider.requests, ([name, requests]) => [name, requests.length]), requestsBeforeManualTopic);
  assert.equal(app.store.hasPendingInitialTask(idleSession.id), false);
  await clickPanel(app, manualWorktrees, 5);
  await app.waitForCondition(() => savedChat().create_topic_worktrees === false);
  await clickPanel(app, manualWorktrees, -1);
  const protocol = await app.sendAndWait('/start', idleThreadId);
  const update = app.updates.find(candidate => candidate.message?.message_id === protocol.id)?.message!;
  assert.equal(update.from?.id, app.telegram.user.account.id);
  assert.equal(update.message_thread_id, idleThreadId);
  assert.equal(update.is_topic_message, true);
  assert.ok(update.entities?.some(entity => entity.type === 'bot_command' && entity.offset === 0 && entity.length === 6));
  await setTopicClosed(app, idleSession, true);
  await setTopicClosed(app, idleSession, false);
  const stop = await app.sendAndWait('/stop', idleThreadId);
  await waitForReactionAttempt(app, stop.id, '👀');
  assert.deepEqual(reactionAttempts(app, stop.id), [['👀']]);
  const localCommands = [];
  for (const command of ['/help', '/status', '/skills', '/settings', '/cli']) {
    localCommands.push(await app.sendAndWait(command, idleThreadId));
  }
  const copyPayload = z.object({
    message_thread_id: z.literal(idleThreadId),
    reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({ copy_text: z.object({ text: z.string() }).optional() }))) }),
  });
  const expectedCommand = `omp-telegram-collab session join --chat ${session.chatId} --topic ${idleThreadId}`;
  assert.ok(app.apiCalls.some(call => {
    if (call.method !== 'sendMessage') return false;
    const parsed = copyPayload.safeParse(call.payload);
    return parsed.success && parsed.data.reply_markup.inline_keyboard.flat().some(button => button.copy_text?.text === expectedCommand);
  }));
  assert.equal(await app.runtime.isRunning(idleSession), false);
  for (const command of localCommands) assert.deepEqual(reactionAttempts(app, command.id), []);
  const adminCommands = await app.telegram.api.getMyCommands({ scope: { type: 'chat_administrators', chat_id: session.chatId } });
  assert.ok(adminCommands.some(command => command.command === 'cli'));
  for (const scope of [{ type: 'all_group_chats' as const }, { type: 'chat' as const, chat_id: session.chatId }]) {
    const commands = await app.telegram.api.getMyCommands({ scope });
    assert.ok(!commands.some(command => command.command === 'cli' || command.command === 'session'));
    assert.ok(commands.some(command => command.command === 'p'));
    if (scope.type === 'chat') assert.ok(commands.some(command => command.command === 'skill_e2e_review'));
  }
  const idleTask = await app.sendAndWait(`/p ${tasks.idle.prompt}`, idleThreadId);
  await completeWriteTask(app, tasks.idle, idleTask, idleThreadId);
  await setTopicClosed(app, idleSession, true);

  await app.sendAndWait('/detach', session.threadId);
  assert.equal(app.store.getSession(session.id)?.status, 'detached');
  assert.equal(await app.runtime.isRunning(session), true);
  const detachedHistory = await readSessionHistory(app.omp.dataDir, session.id);
  const ignored = [
    await app.sendAndWait('Detached discussion', session.threadId),
    await app.sendAndWait('/p Never submit this detached instruction', session.threadId),
  ];
  await changeTopicClosed(app, session.threadId, true);
  await changeTopicClosed(app, session.threadId, false);
  const automaticWorktrees = await openPanel(app, '/settings');
  await clickPanel(app, automaticWorktrees, 5);
  await app.waitForCondition(() => savedChat().create_topic_worktrees === true);
  await clickPanel(app, automaticWorktrees, -1);
  const separate = await app.sendAndWait(`/new ${tasks.separate.prompt}`, session.threadId);
  const separateReply = await completeWriteTask(app, tasks.separate, separate);
  const separateSession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === separateReply.replyToMessage?.threadId)!;
  assert.notEqual(separateSession.id, session.id);
  await app.omp.assertWorktree(separateSession);
  assert.equal(app.store.getSession(session.id)?.status, 'detached');
  assert.equal(await app.runtime.isRunning(session), true);
  assert.equal(await readSessionHistory(app.omp.dataDir, session.id), detachedHistory);
  for (const message of ignored) assert.deepEqual(reactionAttempts(app, message.id), []);

  const persistedSettings = await openPanel(app, '/settings', separateSession.threadId);
  await clickPanel(app, persistedSettings, 5);
  await app.waitForCondition(() => savedChat().create_topic_worktrees === false);
  await app.sendAndWait('/skill_e2e_review', separateSession.threadId);
  const persistedSkillKey = { ...skillKey, destination: { kind: 'topic' as const, chatId: session.chatId, threadId: separateSession.threadId } };
  const historyBeforeRestart = await readSessionHistory(app.omp.dataDir, separateSession.id);
  await app.restart();
  assert.equal(app.store.isEnrolled(app.telegram.bot.id, session.chatId), true);
  assert.equal(app.store.getSession(session.id)?.status, 'detached');
  assert.equal(app.store.getSession(created.id)?.status, 'closed');
  assert.equal(app.store.getSession(idleSession.id)?.status, 'closed');
  assert.deepEqual(app.store.getPendingSkills(persistedSkillKey), ['e2e-review']);
  assert.ok((await readSessionHistory(app.omp.dataDir, separateSession.id)).startsWith(historyBeforeRestart));
  await clickPanel(app, persistedSettings, 0);
  await app.waitForCondition(() => savedChat().all_messages_are_prompts === false);
  await clickPanel(app, persistedSettings, 0);
  await app.waitForCondition(() => savedChat().all_messages_are_prompts === true);
  const restarted = await app.sendAndWait(`/p ${tasks.restarted.prompt}`, separateSession.threadId);
  await completeWriteTask(app, tasks.restarted, restarted, separateSession.threadId);
  assert.deepEqual(app.store.getPendingSkills(persistedSkillKey), []);
  assert.ok(taskInput(app.omp.provider, tasks.restarted).text.includes(`/skill:e2e-review\n\n${tasks.restarted.prompt}`));
  assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.restarted.name)![0]!.messages).includes(tasks.separate.evidence.nonce));

  await app.sendAndWait('/terminate');
  assert.equal(readConfig(app.config.configPath).terminated, true);
  assert.deepEqual(await app.omp.listHosts(), []);
  const sessionIds = app.store.listSessions(app.telegram.bot.id).map(current => current.id);
  await app.sendAndWait(`/new ${tasks.restored.prompt}`);
  await app.sendAndWait(`/p ${tasks.restored.prompt}`, separateSession.threadId);
  assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), sessionIds);
  await app.restart();
  assert.equal(readConfig(app.config.configPath).terminated, true);
  await app.sendAndWait('/status');
  assert.deepEqual(await app.omp.listHosts(), []);
  const resumedConfig = readConfig(app.config.configPath);
  delete resumedConfig.terminated;
  writeConfig(resumedConfig);
  const restored = await app.sendAndWait(`/p ${tasks.restored.prompt}`, separateSession.threadId);
  await completeWriteTask(app, tasks.restored, restored, separateSession.threadId);
  assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.restored.name)![0]!.messages).includes(tasks.restarted.evidence.nonce));
  app.omp.provider.assertComplete();
});
