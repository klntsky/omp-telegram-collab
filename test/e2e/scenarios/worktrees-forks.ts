import assert from 'node:assert/strict';
import { readConfig } from '../../../src/config.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, deliveredMessageLinks, openPanel, replyText, setTopicClosed } from '../helpers/telegram-actions.js';
import { completeWriteTask, readSessionHistory } from '../helpers/model-tasks.js';
import { observeBrowser } from '../helpers/browser-observer.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerWorktreesAndForks(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'initial' | 'worktree' | 'worktreeRestarted' | 'forkTip' | 'forkAnswer' | 'forkPrompt'>, getPreviousIds: () => Set<string>): void {
  it('worktrees and forks', async t => {
    const app = getApp();
    const previousIds = getPreviousIds();
    const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
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
  
    const settings = await openPanel(app, '/settings');
    for (const [index, key] of [[0, 'all_messages_are_prompts'], [1, 'users_can_propose_prompts'], [5, 'create_topic_worktrees']] as const) {
      const original = savedChat()[key];
      await clickPanel(app, settings, index);
      await app.waitForCondition(() => savedChat()[key] === !original);
      await clickPanel(app, settings, index);
      await app.waitForCondition(() => savedChat()[key] === original);
    }
    await clickPanel(app, settings, -1);
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(value => value.id), [...previousIds]);
  
    const sent = await app.sendAndWait(`/new ${tasks.initial.prompt}`);
    const reply = await completeWriteTask(app, tasks.initial, sent);
    await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
    const sessions = app.store.listSessions(app.telegram.bot.id).filter(value => !previousIds.has(value.id));
    assert.equal(sessions.length, 1);
    let session = sessions[0]!;
    assert.equal(session.chatId, app.telegram.forum.chatId);
    assert.equal(session.cwd, app.omp.workspace);
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
    const worktree = await app.sendAndWait(`/p ${tasks.worktree.prompt}`, session.threadId);
    await completeWriteTask(app, tasks.worktree, worktree, session.threadId);
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.worktree.name)![0]!.messages).includes(tasks.initial.evidence.nonce));
    await assert.rejects(readFile(join(app.omp.workspace, tasks.worktree.path), 'utf8'), { code: 'ENOENT' });
    const worktreeRuntime = session.runtime;
    await app.restart();
    session = app.store.getSession(session.id)!;
    assert.deepEqual(session.runtime, worktreeRuntime);
    const browser = await observeBrowser(t, app, session);
    const snapshot = browser.client.getSnapshot();
    assert.ok(JSON.stringify(snapshot.entries).includes(tasks.initial.toolCallId));
    assert.ok(JSON.stringify(snapshot.entries).includes(tasks.initial.evidence.nonce));
    assert.ok(JSON.stringify(snapshot.entries).includes('Original diagnostic'));
    assert.ok(snapshot.state);
    const historyBeforeDenied = await readSessionHistory(app.omp.dataDir, session.id);
    await browser.denyMutations();
    assert.equal(await readSessionHistory(app.omp.dataDir, session.id), historyBeforeDenied);
    const worktreeRestarted = await app.sendAndWait(`/p ${tasks.worktreeRestarted.prompt}`, session.threadId);
    await completeWriteTask(app, tasks.worktreeRestarted, worktreeRestarted, session.threadId);
    await browser.waitForSnapshot(value => !value.working && value.entries.some(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult' &&
      entry.message.toolCallId === tasks.worktreeRestarted.toolCallId && !entry.message.isError));
    assert.ok(browser.frames.some(frame => frame.t === 'event' && frame.event.type === 'tool_execution_start'));
    assert.ok(browser.frames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
    assert.ok(JSON.stringify(browser.client.getSnapshot().entries).includes(tasks.worktreeRestarted.evidence.nonce));
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.worktreeRestarted.name)![0]!.messages).includes(tasks.worktree.evidence.nonce));
  
    const sourceBinding = JSON.parse(await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8'));
    const sourceBeforeForks = app.store.getSession(session.id)!;
    const sourceHost = await app.runtime.resolveExisting(session);
    assert.ok(sourceHost);
    const forkSettings = await openPanel(app, '/settings');
    for (const [task, replyId, automaticWorktree] of [
      [tasks.forkTip, undefined, false],
      [tasks.forkAnswer, reply.id, true],
      [tasks.forkPrompt, worktreeRestarted.id, false],
    ] as const) {
      if ((savedChat().create_topic_worktrees === true) !== automaticWorktree) {
        await clickPanel(app, forkSettings, 5);
        await app.waitForCondition(() => savedChat().create_topic_worktrees === automaticWorktree);
      }
      const previousSessions = new Set(app.store.listSessions(app.telegram.bot.id).map(value => value.id));
      const sourceHistory = await readSessionHistory(app.omp.dataDir, session.id);
      const forkCallStart = app.apiCalls.length;
      const command = replyId === undefined
        ? await app.sendAndWait('/fork', session.threadId)
        : await replyText(app, replyId, session.threadId, '/fork');
      const fork = app.store.listSessions(app.telegram.bot.id).find(value => !previousSessions.has(value.id));
      assert.ok(fork?.runtime.kind === 'managed');
      assert.notEqual(fork.threadId, session.threadId);
      assert.deepEqual(app.store.getSession(session.id), sourceBeforeForks);
      assert.equal(await readSessionHistory(app.omp.dataDir, session.id), sourceHistory);
      assert.deepEqual(JSON.parse(await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8')), sourceBinding);
      assert.deepEqual(await app.runtime.resolveExisting(session), sourceHost);
      const forkCalls = app.apiCalls.slice(forkCallStart);
      const internalChat = String(session.chatId).replace(/^-100/, '');
      assert.ok(deliveredMessageLinks(forkCalls, session.threadId).some(link =>
        link.hostname === 't.me' && link.pathname === `/c/${internalChat}/${fork.threadId}`));
      assert.ok(deliveredMessageLinks(forkCalls, fork.threadId).some(link =>
        link.hostname === 't.me' && link.pathname === `/c/${internalChat}/${replyId ?? command.id}` &&
        link.searchParams.get('thread') === String(session.threadId)));
      const forkHistory = (await readSessionHistory(app.omp.dataDir, fork.id)).trim().split('\n').map(line => JSON.parse(line));
      const forkHeader = forkHistory.find(entry => entry.type === 'session');
      assert.ok(forkHeader);
      assert.notEqual(forkHeader.id, sourceBinding.sessionId);
      assert.ok(forkHistory.some(entry => entry.type === 'custom_message' && entry.customType === 'collab-prompt'));
      assert.equal(forkHistory.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
        entry.message.toolCallId === tasks.worktreeRestarted.toolCallId), task === tasks.forkTip);
      if (automaticWorktree) await app.omp.assertWorktree(fork);
      else assert.equal(fork.cwd, session.cwd);
      const instruction = await app.sendAndWait(`/p ${task.prompt}`, fork.threadId);
      await completeWriteTask(app, task, instruction, fork.threadId);
      const modelHistory = JSON.stringify(app.omp.provider.requests.get(task.name)![0]!.messages);
      assert.ok(modelHistory.includes(tasks.initial.evidence.nonce));
      assert.equal(modelHistory.includes(tasks.worktreeRestarted.toolCallId), task === tasks.forkTip);
      assert.equal(await readSessionHistory(app.omp.dataDir, session.id), sourceHistory);
      await setTopicClosed(app, fork, true);
    }
    await clickPanel(app, forkSettings, -1);
    assert.equal(browser.client.getSnapshot().phase, 'live');
    const sourceEntries = JSON.stringify(browser.client.getSnapshot().entries);
    assert.ok(sourceEntries.includes(tasks.worktreeRestarted.toolCallId));
    for (const task of [tasks.forkTip, tasks.forkAnswer, tasks.forkPrompt]) {
      assert.ok(!sourceEntries.includes(task.toolCallId));
    }
    app.omp.provider.assertComplete([tasks.initial.name, tasks.worktree.name, tasks.worktreeRestarted.name, tasks.forkTip.name, tasks.forkAnswer.name, tasks.forkPrompt.name]);
  });
}
