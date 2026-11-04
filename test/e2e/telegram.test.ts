import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { z } from 'zod';
import { readConfig, writeConfig } from '../../src/config.js';
import type { AppConfig } from '../../shared/contracts.js';
import { setupCollaborationTest, type CollaborationTest } from './helpers/collaboration-fixture.js';
import { startCollaborationProcess } from './helpers/application-process.js';
import { changeTopicClosed, clickPanel, createManagedTopic, deliveredMessageLinks, enrollForum, openPanel, reactionAttempts, replyText, sendImageDocument, setTopicClosed, waitForEditor, waitForPanel, waitForReactionAttempt } from './helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, questionScenario, questionStep, readSessionHistory, taskInput, writeScenario } from './helpers/model-tasks.js';

test('Telegram fork failures preserve completed forks and reject interrupted preparation', { timeout: 480000 }, async t => {
  const seed = createWriteTask('fork-failure-seed');
  const recovery = createWriteTask('fork-notification-recovery');
  const probe = createWriteTask('fork-interruption-probe');
  const app = await setupCollaborationTest(t, { scenarios: [seed, recovery, probe].map(writeScenario) });
  await enrollForum(app);
  const initial = await app.sendAndWait(`/new ${seed.prompt}`);
  await completeWriteTask(app, seed, initial);
  await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
  const source = app.store.listSessions(app.telegram.bot.id)[0]!;
  const sourceHistory = await readSessionHistory(app.omp.dataDir, source.id);
  const bindingPath = join(app.omp.dataDir, 'sessions', source.id, 'binding.json');
  const sourceBinding = await readFile(bindingPath, 'utf8');
  assert.ok(sourceHistory.includes(seed.toolCallId));
  assert.ok(sourceHistory.includes(seed.evidence.nonce));

  await t.test('completed fork survives lost source notification', async () => {
    const existing = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
    const diagnostic = new Error('E2E transport dropped the delivered final fork source-link response');
    let dropped = false;
    let destinationId: string | undefined;
    let deliveredLink: URL | undefined;
    let intercept = true;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (!intercept || method !== 'sendMessage') return previous(method, payload, signal);
      const request = payload as Parameters<typeof app.bot.api.raw.sendMessage>[0];
      const destination = app.store.listSessions(app.telegram.bot.id).find(session => !existing.has(session.id));
      const link = String(request.text).match(/https:\/\/t\.me\/c\/\d+\/\d+/)?.[0];
      if (!dropped && destination && request.chat_id === source.chatId &&
          request.message_thread_id === source.threadId && link &&
          new URL(link).pathname.endsWith(`/${destination.threadId}`)) {
        assert.ok((await readSessionHistory(app.omp.dataDir, destination.id)).includes(seed.toolCallId));
        assert.ok(await app.runtime.resolveExisting(destination));
        const result = await previous(method, payload, signal);
        dropped = true;
        destinationId = destination.id;
        deliveredLink = new URL(link);
        app.omp.log('fork.notification.dropped-response', { destinationId, payload, result, diagnostic });
        throw diagnostic;
      }
      return previous(method, payload, signal);
    });
    try {
      await app.sendAndWait('/fork', source.threadId);
    } finally {
      intercept = false;
    }
    assert.equal(dropped, true);
    assert.equal(deliveredLink?.protocol, 'https:');
    assert.equal(deliveredLink?.hostname, 't.me');
    const destination = app.store.getSession(destinationId!)!;
    assert.equal(deliveredLink?.pathname, `/c/${String(source.chatId).replace(/^-100/, '')}/${destination.threadId}`);
    assert.deepEqual(app.store.getSession(source.id), source);
    assert.equal(await readSessionHistory(app.omp.dataDir, source.id), sourceHistory);
    assert.equal(await readFile(bindingPath, 'utf8'), sourceBinding);
    const preservedHistory = await readSessionHistory(app.omp.dataDir, destination.id);
    assert.ok(preservedHistory.includes(seed.toolCallId));
    try {
      const target = destination.status === 'open' ? destination : source;
      const sent = await app.sendAndWait(`/p ${recovery.prompt}`, target.threadId);
      await completeWriteTask(app, recovery, sent, target.threadId);
      assert.ok(JSON.stringify(app.omp.provider.requests.get(recovery.name)![0]!.messages).includes(seed.evidence.nonce));
      assert.equal(destination.status, 'open', diagnostic.message);
      assert.equal(await readSessionHistory(app.omp.dataDir, source.id), sourceHistory);
    } finally {
      await app.runtime.kill(destination);
    }
  });

  await t.test('interrupted fork cannot resume with empty history', async child => {
    const before = app.store.getSession(source.id)!;
    app.config.omp.maxSessions = 4;
    writeConfig(app.config);
    await app.pause();
    const history = await readSessionHistory(app.omp.dataDir, source.id);
    const process = await startCollaborationProcess(child, {
      configPath: app.config.configPath, topicActivityEmojis: app.topicActivityEmojis, log: app.omp.log,
    });
    let interruptedId: string | undefined;
    try {
      await app.send('/fork', source.threadId);
      const prepared = await process.forkPrepared;
      assert.equal(prepared.sourceId, source.id);
      interruptedId = prepared.destinationId;
      const directory = join(app.omp.dataDir, 'sessions', interruptedId);
      await assert.rejects(stat(join(directory, 'binding.json')), { code: 'ENOENT' });
      await assert.rejects(stat(join(directory, 'history.jsonl')), { code: 'ENOENT' });
      const scratch = (await readdir(directory)).filter(name => name.startsWith('fork-'));
      assert.ok(scratch.length > 0);
      const nativeHistories = await Promise.all(scratch.map(async name => {
        const path = join(directory, name);
        const files = await readdir(path, { recursive: true });
        return Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => readFile(join(path, file), 'utf8')));
      }));
      assert.ok(nativeHistories.flat().some(contents => contents.includes(seed.toolCallId) && contents.includes(seed.evidence.nonce)));
    } finally {
      const exit = await process.kill();
      assert.equal(exit.signal, 'SIGKILL');
      await app.restart();
    }
    const destination = app.store.getSession(interruptedId!)!;
    assert.ok(destination);
    const sent = await app.sendAndWait(`/p ${probe.prompt}`, destination.threadId);
    const admitted = await stat(join(app.omp.dataDir, 'sessions', destination.id, 'binding.json')).then(
      () => true,
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; },
    );
    if (admitted) {
      await completeWriteTask(app, probe, sent, destination.threadId);
      app.omp.log('fork.interrupted.wrong-context', {
        destinationId: destination.id,
        messages: app.omp.provider.requests.get(probe.name)![0]!.messages,
        history: await readSessionHistory(app.omp.dataDir, destination.id),
      });
    } else {
      const fallback = await app.sendAndWait(`/new ${probe.prompt}`);
      await completeWriteTask(app, probe, fallback);
    }
    assert.deepEqual(app.store.getSession(source.id), before);
    assert.equal(await readFile(bindingPath, 'utf8'), sourceBinding);
    assert.equal(await readSessionHistory(app.omp.dataDir, source.id), history);
    assert.equal(app.store.getSession(destination.id)?.status, 'detached',
      'Interrupted native fork must remain rejected instead of starting a fresh empty conversation');
    assert.equal(admitted, false, 'Interrupted fork must not submit a prompt to an empty native history');
    await assert.rejects(stat(join(app.omp.dataDir, 'sessions', destination.id, 'binding.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(app.omp.dataDir, 'sessions', destination.id, 'history.jsonl')), { code: 'ENOENT' });
  });
});

describe('Telegram workflows', { concurrency: false, timeout: 900000 }, suite => {
  const tasks = {
    lifecycleSeed: createWriteTask('lifecycle-seed'),
    identitySeed: createWriteTask('identity-seed'),
    terminationSeed: createWriteTask('termination-seed'),
    lifecyclePeer: createWriteTask('lifecycle-peer'),
    terminationPeer: createWriteTask('termination-peer'),
    initial: createWriteTask('initial', '\n/home/example/project/error.ts:27\n  throw new Error("Original diagnostic");\n    at run (/home/example/project/error.ts:27:11)\n/stop /unknown'),
    worktree: createWriteTask('worktree'),
    worktreeRestarted: createWriteTask('worktree-restarted'),
    question: createWriteTask('question'),
    customAnswer: createWriteTask('custom-answer'),
    askHandoff: createWriteTask('ask-handoff'),
    chatHandoff: createWriteTask('chat-handoff'),
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
    forkTip: createWriteTask('fork-tip'),
    forkAnswer: createWriteTask('fork-answer'),
    forkPrompt: createWriteTask('fork-prompt'),
    identityOld: createWriteTask('identity-old'),
    identityNew: createWriteTask('identity-new'),
    identityOldRestarted: createWriteTask('identity-old-restarted'),
    identityNewRestarted: createWriteTask('identity-new-restarted'),
  };
  const interrupted = { name: 'interrupted', prompt: `Wait for a stop command ${tasks.initial.evidence.nonce}` };
  const cancelledQuestion = { name: 'cancelled-question', prompt: `Ask before the next task ${tasks.initial.evidence.nonce}` };
  const questionControls = ['chat-question', 'dismiss-question'].map(name => ({
    name, prompt: `${name} ${tasks.initial.evidence.nonce}`, steps: name === 'chat-question'
      ? [questionStep(name), { type: 'text' as const, text: 'Continue the discussion in Telegram.' }]
      : [questionStep(name)],
  }));
  const scenarios = Object.values(tasks).map(task =>
    task === tasks.question || task === tasks.customAnswer ? questionScenario(task) : writeScenario(task));
  let app: CollaborationTest;
  let baseline: AppConfig;
  const cleanups: Array<() => void | Promise<void>> = [];
  let previousIds: Set<string>;
  after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
  before(async () => {
    app = await setupCollaborationTest({
      signal: suite.signal,
      diagnostic: message => suite.diagnostic(message),
      after: cleanup => { cleanups.push(cleanup); },
    }, { scenarios: [
      ...scenarios,
      { ...interrupted, steps: [{ type: 'await-abort' }] },
      { ...cancelledQuestion, steps: [questionStep(cancelledQuestion.name)] },
      ...questionControls,
    ] });
    await enrollForum(app);
    baseline = structuredClone(readConfig(app.config.configPath));
  });
  beforeEach(async () => {
    writeConfig(structuredClone(baseline));
    app.setFolderOptions([]);
    await app.restart();
    await app.sendAndWait('/skills clear');
    previousIds = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const session of app.store.listSessions(app.telegram.bot.id)) {
      if (previousIds.has(session.id)) continue;
      try { await app.runtime.kill(session); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
  const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
  it('worktrees and forks', async () => {
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
    const worktreeRestarted = await app.sendAndWait(`/p ${tasks.worktreeRestarted.prompt}`, session.threadId);
    await completeWriteTask(app, tasks.worktreeRestarted, worktreeRestarted, session.threadId);
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
    app.omp.provider.assertComplete([tasks.initial.name, tasks.worktree.name, tasks.worktreeRestarted.name, tasks.forkTip.name, tasks.forkAnswer.name, tasks.forkPrompt.name]);
  });
  it('questions', async t => {
    const session = await createManagedTopic(app);
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
  
    const questionSettings = await openPanel(app, '/settings', session.threadId);
    await clickPanel(app, questionSettings, 0);
    await app.waitForCondition(() => savedChat().all_messages_are_prompts === false);
    for (const control of questionControls) {
      const start = app.apiCalls.length;
      const frameStart = app.hostFrames.length;
      const instruction = await app.sendAndWait(`/p ${control.prompt}`, session.threadId);
      const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
      const request = app.hostFrames.slice(frameStart).findLast(frame => frame.t === 'ui-request');
      assert.ok(request?.t === 'ui-request');
      if (control.name === 'chat-question') {
        await clickPanel(app, panel, 3);
        await app.waitForCondition(() => app.hostFrames.slice(frameStart).some(frame => frame.t === 'ui-request-end' && frame.reqId === request.request.reqId));
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === request.request.reqId && frame.value === 'Chat about this'));
        await app.waitForReply({ replyToMessageId: instruction.id, threadId: session.threadId });
        const discussion = await replyText(app, panel.messageId, session.threadId, tasks.chatHandoff.prompt);
        await completeWriteTask(app, tasks.chatHandoff, discussion, session.threadId);
      } else {
        const editorStart = app.apiCalls.length;
        await clickPanel(app, panel, 2);
        const editorMessage = await waitForEditor(app, editorStart, session.threadId);
        const editor = app.hostFrames.findLast(frame => frame.t === 'ui-request');
        assert.ok(editor?.t === 'ui-request' && editor.request.kind === 'editor');
        const cancellation = await waitForPanel(app, 'question', 'ask:', editorStart, session.threadId);
        const dismissStart = app.apiCalls.length;
        await clickPanel(app, cancellation, 0);
        await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'ui-request-end' && frame.reqId === editor.request.reqId));
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === editor.request.reqId && frame.value === undefined));
        const parent = await waitForPanel(app, 'question', 'ask:', dismissStart, session.threadId);
        const parentRequest = app.hostFrames.findLast(frame => frame.t === 'ui-request');
        assert.ok(parentRequest?.t === 'ui-request' && parentRequest.request.kind === 'select');
        await clickPanel(app, parent, -1);
        await app.waitForCondition(() => app.hostFrames.slice(frameStart).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === parentRequest.request.reqId && frame.value === undefined));
        const lateAnswer = 'Do not submit this cancelled editor reply';
        await replyText(app, editorMessage, session.threadId, lateAnswer);
        assert.ok(!app.guestFrames.some(frame => frame.t === 'prompt' && frame.text === lateAnswer));
      }
    }
    await clickPanel(app, questionSettings, 0);
    await app.waitForCondition(() => savedChat().all_messages_are_prompts === true);
    await clickPanel(app, questionSettings, -1);
    app.omp.provider.assertComplete([tasks.question.name, tasks.customAnswer.name, tasks.askHandoff.name, tasks.chatHandoff.name, interrupted.name, cancelledQuestion.name, ...questionControls.map(control => control.name)]);
  });
  it('media, skills, and folders', async () => {
    const session = await createManagedTopic(app);
    const sessionsAfterForks = app.store.listSessions(app.telegram.bot.id).map(value => value.id);
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
  
    await app.waitForCondition(() => app.store.getSkillCatalog(session.instanceId)?.some(skill => skill.name === 'e2e-review') ?? false);
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
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(value => value.id), sessionsAfterForks);
    assert.deepEqual(app.store.getPendingSkills(skillKey), []);
    assert.ok(taskInput(app.omp.provider, tasks.followup).text.includes(`/skill:e2e-review\n\n${tasks.followup.prompt}`));
  
    const selectedDirectory = join(app.omp.workspace, 'selected', 'nested');
    app.setFolderOptions(['selected/nested']);
    await app.sendAndWait('/skill_e2e_review');
    const folderStart = app.apiCalls.length;
    await app.sendAndWait(tasks.general.prompt);
    const folders = await waitForPanel(app, 'folder', 'folder:', folderStart);
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), sessionsAfterForks);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), ['e2e-review']);
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    await clickPanel(app, folders, folders.buttons.findIndex(data => data.endsWith(':cancel')));
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), sessionsAfterForks);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), ['e2e-review']);
    app.setFolderOptions(['.', 'selected/nested']);
    const confirmationStart = app.apiCalls.length;
    const general = await app.sendAndWait(tasks.general.prompt);
    const choices = await waitForPanel(app, 'folder', 'folder:', confirmationStart);
    const creationStart = app.apiCalls.length;
    await clickPanel(app, choices, 1);
    const confirmation = await waitForPanel(app, 'folder', 'folder:', creationStart);
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    await clickPanel(app, confirmation, confirmation.buttons.findIndex(data => data.endsWith(':create')));
    const generalReply = await completeWriteTask(app, tasks.general, general);
    const allSessions = app.store.listSessions(app.telegram.bot.id);
    const created = allSessions.find(value => !sessionsAfterForks.includes(value.id))!;
    assert.deepEqual(allSessions.map(value => value.id).filter(id => id !== created.id), sessionsAfterForks);
    assert.deepEqual(created.runtime, { kind: 'managed' });
    assert.equal(created.instanceId, 1);
    assert.equal(created.cwd, selectedDirectory);
    await assert.rejects(readFile(join(app.omp.workspace, tasks.general.path), 'utf8'), { code: 'ENOENT' });
    app.setFolderOptions([]);
    assert.notEqual(created.threadId, session.threadId);
    assert.notEqual(created.threadId, 1);
    assert.equal(generalReply.replyToMessage?.threadId, created.threadId);
    assert.equal(app.store.getTopic({ botId: app.telegram.bot.id, destination: { kind: 'general', chatId: session.chatId } }), undefined);
    assert.equal(app.store.hasPendingInitialTask(created.id), false);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
    assert.ok(taskInput(app.omp.provider, tasks.general).text.includes(`/skill:e2e-review\n\n${tasks.general.prompt}`));
    app.omp.provider.assertComplete([tasks.image.name, tasks.explicitImage.name, tasks.settingsReply.name, tasks.followup.name, tasks.general.name]);
  });
  it('lifecycle, idle, detach, and restart', async () => {
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
    app.omp.provider.assertComplete([tasks.lifecycleSeed.name, tasks.lifecyclePeer.name, tasks.resumed.name, tasks.reopened.name, tasks.idle.name, tasks.separate.name, tasks.restarted.name]);
  });
  it('logical identity', async () => {
    const seed = await app.sendAndWait(`/new ${tasks.identitySeed.prompt}`);
    const seedReply = await completeWriteTask(app, tasks.identitySeed, seed);
    let separateSession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === seedReply.replyToMessage?.threadId)!;
    await app.omp.git(app.omp.workspace, 'add', '--all');
    await app.omp.git(app.omp.workspace, 'commit', '-m', 'Preserve identity seed evidence');
    await app.sendAndWait('/worktree identity-branch', separateSession.threadId);
    separateSession = app.store.getSession(separateSession.id)!;
    await app.omp.assertWorktree(separateSession, 'identity-branch');
    const oldCwd = separateSession.cwd;
    const identityDirectory = join(app.omp.workspace, 'identity-default');
    await mkdir(identityDirectory, {recursive:true});
    const identityConfig = readConfig(app.config.configPath);
    const logicalInstance = identityConfig.instances.find(instance => instance.id === separateSession.instanceId)!;
    logicalInstance.defaultDir = identityDirectory;
    identityConfig.instances = [{id: 2, defaultDir: identityDirectory, chats: []}, logicalInstance];
    writeConfig(identityConfig);
    const identityHistory = await readSessionHistory(app.omp.dataDir, separateSession.id);
    const oldFollowup = await app.sendAndWait(`/p ${tasks.identityOld.prompt}`, separateSession.threadId);
    await completeWriteTask(app, tasks.identityOld, oldFollowup, separateSession.threadId);
    assert.equal(app.store.getSession(separateSession.id)?.cwd, oldCwd);
    assert.ok((await readSessionHistory(app.omp.dataDir, separateSession.id)).startsWith(identityHistory));
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.identityOld.name)![0]!.messages).includes(tasks.identitySeed.evidence.nonce));
    const identityNew = await app.sendAndWait(`/new ${tasks.identityNew.prompt}`);
    const identityReply = await completeWriteTask(app, tasks.identityNew, identityNew);
    const identitySession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === identityReply.replyToMessage?.threadId)!;
    assert.equal(identitySession.instanceId, separateSession.instanceId);
    assert.equal(identitySession.cwd, identityDirectory);
    assert.equal(await readFile(join(identityDirectory,tasks.identityNew.path),'utf8'), JSON.stringify(tasks.identityNew.evidence));
    await assert.rejects(stat(join(oldCwd,tasks.identityNew.path)), {code:'ENOENT'});
    const newIdentityHistory = await readSessionHistory(app.omp.dataDir, identitySession.id);
    await app.restart();
    assert.equal(app.store.getSession(separateSession.id)?.cwd, oldCwd);
    assert.equal(app.store.getSession(identitySession.id)?.cwd, identityDirectory);
    assert.equal(app.store.getSession(identitySession.id)?.instanceId, separateSession.instanceId);
    const oldRestarted = await app.sendAndWait(`/p ${tasks.identityOldRestarted.prompt}`, separateSession.threadId);
    await completeWriteTask(app,tasks.identityOldRestarted,oldRestarted,separateSession.threadId);
    const newRestarted = await app.sendAndWait(`/p ${tasks.identityNewRestarted.prompt}`,identitySession.threadId);
    await completeWriteTask(app,tasks.identityNewRestarted,newRestarted,identitySession.threadId);
    assert.ok((await readSessionHistory(app.omp.dataDir,identitySession.id)).startsWith(newIdentityHistory));
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.identityOldRestarted.name)![0]!.messages).includes(tasks.identityOld.evidence.nonce));
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.identityNewRestarted.name)![0]!.messages).includes(tasks.identityNew.evidence.nonce));
    app.omp.provider.assertComplete([tasks.identitySeed.name, tasks.identityOld.name, tasks.identityNew.name, tasks.identityOldRestarted.name, tasks.identityNewRestarted.name]);
  });
  it('termination', async () => {
    const seed = await app.sendAndWait(`/new ${tasks.terminationSeed.prompt}`);
    const seedReply = await completeWriteTask(app, tasks.terminationSeed, seed);
    const separateSession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === seedReply.replyToMessage?.threadId)!;
    const peer = await createManagedTopic(app);
    const peerTask = await app.sendAndWait(`/p ${tasks.terminationPeer.prompt}`, peer.threadId);
    await completeWriteTask(app, tasks.terminationPeer, peerTask, peer.threadId);
    assert.equal(await app.runtime.isRunning(separateSession), true);
    assert.equal(await app.runtime.isRunning(peer), true);
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
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.restored.name)![0]!.messages).includes(tasks.terminationSeed.evidence.nonce));
    app.omp.provider.assertComplete([tasks.terminationSeed.name, tasks.terminationPeer.name, tasks.restored.name]);
  });
});
