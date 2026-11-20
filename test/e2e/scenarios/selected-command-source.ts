import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readConfig, writeConfig } from '../../../src/config.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, replyText, setTopicClosed, waitForEditor, waitForPanel } from '../helpers/telegram-actions.js';
import { enableInlineMode, sendInlineSkill } from '../helpers/telegram-inline.js';
import { completeWriteTask, createWriteTask, questionStep, readSessionHistory, writeScenario } from '../helpers/model-tasks.js';

export function registerSelectedCommandSource(getApp: () => CollaborationTest): void {
  it('selected command sources preserve fork, inline skill, and question semantics', async () => {
    const app = getApp();
    await enableInlineMode(app);
    const config = readConfig(app.config.configPath);
    config.instances[0]!.chats[0]!.all_messages_are_prompts = false;
    config.instances[0]!.chats[0]!.create_topic_worktrees = false;
    writeConfig(config);
    await app.restart();
    const session = await createManagedTopic(app);
    const seed = createWriteTask('selected-source-seed');
    const tip = createWriteTask('selected-source-tip');
    for (const task of [seed, tip]) app.omp.provider.addScenario(writeScenario(task));
    const first = await app.sendAndWait(`/p ${seed.prompt}`, session.threadId);
    await completeWriteTask(app, seed, first, session.threadId);
    const last = await app.sendAndWait(`/p ${tip.prompt}`, session.threadId);
    await completeWriteTask(app, tip, last, session.threadId);
    const binding = await app.runtime.existingBinding(session);
    assert.ok(binding);
    const history = await readSessionHistory(app.omp.dataDir, session.id);
    const initialForkIds = new Set(app.store.listSessions(app.telegram.bot.id).map(value => value.id));
    const forkCommand = await app.sendAndWait('/fork', session.threadId);
    const initialFork = app.store.listSessions(app.telegram.bot.id).find(value => !initialForkIds.has(value.id));
    assert.ok(initialFork);
    await setTopicClosed(app, initialFork, true);
    for (const [target, command, includesTip] of [
      [forkCommand.id, '/p', true],
      [forkCommand.id, `@${app.telegram.bot.username}`, true],
      [first.id, '/fork', false],
    ] as const) {
      const before = new Set(app.store.listSessions(app.telegram.bot.id).map(value => value.id));
      await replyText(app, target, session.threadId, command);
      const fork = app.store.listSessions(app.telegram.bot.id).find(value => !before.has(value.id));
      assert.ok(fork?.runtime.kind === 'managed');
      assert.ok(await app.runtime.existingBinding(fork));
      const forkHistory = await readSessionHistory(app.omp.dataDir, fork.id);
      assert.equal(forkHistory.includes(tip.toolCallId), includesTip);
      assert.deepEqual(await app.runtime.existingBinding(session), binding);
      assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);
      await setTopicClosed(app, fork, true);
    }

    const key = { botId: app.telegram.bot.id, destination: { kind: 'topic' as const,
      chatId: session.chatId, threadId: session.threadId }, userId: app.telegram.user.account.id };
    for (const trigger of ['/p', `@${app.telegram.bot.username}`]) {
      const source = await sendInlineSkill(app, session.threadId);
      assert.deepEqual(app.store.getPendingSkills(key), ['e2e-review']);
      await app.sendAndWait('/skills clear', session.threadId);
      assert.deepEqual(app.store.getPendingSkills(key), []);
      await replyText(app, source, session.threadId, trigger);
      assert.deepEqual(app.store.getPendingSkills(key), ['e2e-review']);
      await app.sendAndWait('/skills clear', session.threadId);
    }

    // Read the actual delivered editor content into the model script: no test
    // assumption about UI wording and no fabricated Telegram message/entities.
    for (const expired of [false, true]) {
      const name = expired ? 'selected-expired-question' : 'selected-active-editor';
      const task = createWriteTask(`${name}-write`);
      const question = { name, prompt: `Ask ${name} ${task.evidence.nonce}`,
        steps: [questionStep(name), { type: 'text' as const, text: 'Question complete.' }] };
      app.omp.provider.addScenario(question);
      const start = app.apiCalls.length;
      await app.sendAndWait(`/p ${question.prompt}`, session.threadId);
      const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
      const editorStart = app.apiCalls.length;
      await clickPanel(app, panel, 2);
      const editorId = await waitForEditor(app, editorStart, session.threadId);
      const editor = app.hostFrames.findLast(frame => frame.t === 'ui-request');
      assert.ok(editor?.t === 'ui-request' && editor.request.kind === 'editor');
      const [message] = await app.telegram.user.client.getMessages(app.telegram.forum.chat, editorId);
      assert.ok(message?.text);
      app.omp.provider.addScenario({ ...writeScenario(task), prompt: message.text });
      if (expired) {
        await app.sendAndWait('/stop', session.threadId);
        await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'ui-request-end' && frame.reqId === editor.request.reqId));
      }
      const frameStart = app.guestFrames.length;
      const selected = await replyText(app, editorId, session.threadId, `@${app.telegram.bot.username}`);
      await completeWriteTask(app, task, selected, session.threadId);
      assert.ok(!app.guestFrames.slice(frameStart).some(frame => frame.t === 'ui-response' &&
        frame.value === `@${app.telegram.bot.username}`));
      assert.ok(app.guestFrames.slice(frameStart).some(frame => frame.t === 'prompt' && frame.text.includes(message.text)));
      assert.deepEqual(await app.runtime.existingBinding(session), binding);
      app.omp.provider.assertComplete([task.name]);
    }
    app.omp.provider.assertComplete([seed.name, tip.name]);
  });
}
