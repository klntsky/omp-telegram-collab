import assert from 'node:assert/strict';
import { readConfig } from '../../../src/config.js';
import { join } from 'node:path';
import { z } from 'zod';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { changeTopicClosed, clickPanel, createManagedTopic, openPanel, reactionAttempts, setTopicClosed, waitForReactionAttempt } from '../helpers/telegram-actions.js';
import { completeWriteTask, readSessionHistory, taskInput } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerLifecycle(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'lifecycleSeed' | 'lifecyclePeer' | 'resumed' | 'reopened' | 'idle' | 'separate' | 'restarted'>): void {
  it('lifecycle, idle, detach, and restart', async () => {
    const app = getApp();
    const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
    const seed = await app.sendAndWait(`/new ${tasks.lifecycleSeed.prompt}`);
    const seedReply = await completeWriteTask(app, tasks.lifecycleSeed, seed);
    const session = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === seedReply.replyToMessage?.threadId)!;
    const created = await createManagedTopic(app);
    const peerTask = await app.sendAndWait(`/p ${tasks.lifecyclePeer.prompt}`, created.threadId);
    await completeWriteTask(app, tasks.lifecyclePeer, peerTask, created.threadId);
    const skillKey = { botId: app.telegram.bot.id, destination: { kind: 'topic' as const, chatId: session.chatId, threadId: session.threadId }, userId: app.telegram.user.account.id };
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
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.resumed.name)![0]!.messages).includes(tasks.lifecycleSeed.evidence.nonce));
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
      assert.ok(!commands.some(command => command.command === 'cli' || command.command === 'agent'));
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
    app.omp.provider.assertComplete([tasks.lifecycleSeed.name, tasks.lifecyclePeer.name, tasks.resumed.name, tasks.reopened.name, tasks.idle.name, tasks.separate.name, tasks.restarted.name]);
  });
}
