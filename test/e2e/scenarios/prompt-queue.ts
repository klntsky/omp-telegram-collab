import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { completeWriteTask, createWriteTask, taskInput, taskReadResult, writeReadScenario, writeScenario } from '../helpers/model-tasks.js';
import { createManagedTopic, enrollForum, sendDocument } from '../helpers/telegram-actions.js';
import { holdTelegramAcknowledgement } from '../helpers/telegram-acknowledgement.js';
import { installRetirementGate } from '../helpers/retirement-gate.js';

export function registerPromptQueue(): void {
  it('native pre-dispatch refusals release the queue for later prompts', { timeout: 240000 }, async t => {
    const seed = createWriteTask('queue-cost-seed');
    const app = await setupCollaborationTest(t, { scenarios: [writeScenario(seed)] });
    await enrollForum(app);
    const modelsPath = join(app.omp.agentConfigPath, '..', 'models.yml');
    const models = JSON.parse(await readFile(modelsPath, 'utf8'));
    for (const model of models.providers.e2e.models)
      model.cost = { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0 };
    await writeFile(modelsPath, JSON.stringify(models));
    const session = await createManagedTopic(app);
    const started = await app.sendAndWait(`/p ${seed.prompt}`, session.threadId);
    await completeWriteTask(app, seed, started, session.threadId);
    const settings = JSON.parse(await readFile(app.omp.agentConfigPath, 'utf8'));
    settings.session = { ...settings.session, maxCost: 0.001 };
    await writeFile(app.omp.agentConfigPath, JSON.stringify(settings));
    await app.runtime.kill(session);
    await app.restart();
    const start = app.hostFrames.length;
    for (const text of ['First capped task', 'Second capped task']) {
      const sent = await app.sendAndWait(`/p ${text}`, session.threadId);
      await app.waitForCondition(() => Boolean(app.store.db.prepare(
        "SELECT 1 FROM prompt_submissions WHERE session_id=? AND message_id=? AND state='uncertain'",
      ).get(session.id, sent.id)));
      assert.equal(app.store.promptQueue.has(session.id), false);
    }
    assert.equal(app.hostFrames.slice(start).some(frame => frame.t === 'event' && frame.event.type === 'agent_start'), false);
    assert.equal(app.omp.provider.requests.get(seed.name)!.length, 2);
    app.omp.provider.assertComplete([seed.name]);
  });

  it('stop preserves FIFO prompts across restart and continue resumes messages admitted while paused', { timeout: 360000 }, async t => {
    const seed = createWriteTask('queue-stop-seed');
    const first = createWriteTask('queue-stop-first');
    const second = createWriteTask('queue-stop-second');
    const paused = createWriteTask('queue-stop-paused');
    const empty = createWriteTask('queue-stop-empty');
    const app = await setupCollaborationTest(t, { scenarios: [
      { name: seed.name, prompt: seed.prompt, steps: [{ type: 'await-abort' }] },
      writeScenario(first),
      writeReadScenario(second, first.path),
      writeReadScenario(paused, second.path),
      writeScenario(empty),
    ] });
    await enrollForum(app);
    const session = await createManagedTopic(app);
    const start = app.hostFrames.length;
    await app.sendAndWait(`/p ${seed.prompt}`, session.threadId);
    await app.waitForTaskStarted(seed.name);
    const firstMessage = await app.sendAndWait(`/p ${first.prompt}`, session.threadId);
    const secondMessage = await app.sendAndWait(`/p ${second.prompt}`, session.threadId);
    assert.equal(app.store.promptQueue.count(session.id), 2);
    const pending = app.store.promptQueue.list(session.id).filter(item => item.state === 'pending');
    assert.deepEqual(pending.map(item => item.messageId), [firstMessage.id, secondMessage.id]);
    await app.sendAndWait('/stop', session.threadId);
    await app.omp.provider.waitForAbort(seed.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
    await app.waitForCondition(() => app.hostFrames.slice(start).some(frame =>
      frame.t === 'event' && frame.event.type === 'agent_end'));
    assert.equal(app.store.promptQueue.isPaused(session.id), true);
    assert.deepEqual(app.store.promptQueue.list(session.id), pending);
    await app.sendAndWait('/stop', session.threadId);
    assert.deepEqual(app.store.promptQueue.list(session.id), pending);
    assert.equal(await app.runtime.isRunning(session), true);

    await app.restart();
    assert.equal(app.store.promptQueue.isPaused(session.id), true);
    assert.deepEqual(app.store.promptQueue.list(session.id), pending);
    const pausedMessage = await app.sendAndWait(`/p ${paused.prompt}`, session.threadId);
    assert.deepEqual(app.store.promptQueue.list(session.id).map(item => item.messageId),
      [firstMessage.id, secondMessage.id, pausedMessage.id]);
    for (const task of [first, second, paused]) {
      assert.deepEqual(app.omp.provider.requests.get(task.name), []);
      assert.equal(app.guestFrames.some(frame => frame.t === 'prompt' && frame.text.includes(task.prompt)), false);
      await assert.rejects(readFile(join(session.cwd, task.path)), { code: 'ENOENT' });
    }
    await app.sendAndWait('/continue', session.threadId);
    await app.sendAndWait('/continue', session.threadId);
    await completeWriteTask(app, first, firstMessage, session.threadId);
    await completeWriteTask(app, second, secondMessage, session.threadId);
    await completeWriteTask(app, paused, pausedMessage, session.threadId);
    assert.ok(JSON.stringify(taskReadResult(app.omp.provider, second)).includes(first.evidence.nonce));
    assert.ok(JSON.stringify(taskReadResult(app.omp.provider, paused)).includes(second.evidence.nonce));
    await app.waitForCondition(() => !app.store.promptQueue.has(session.id));
    assert.equal(app.store.promptQueue.isPaused(session.id), false);
    assert.deepEqual(app.guestFrames.flatMap(frame => {
      if (frame.t !== 'prompt') return [];
      const task = [first, second, paused].find(candidate => frame.text.includes(candidate.prompt));
      return task ? [task.name] : [];
    }), [first.name, second.name, paused.name]);

    await app.sendAndWait('/stop', session.threadId);
    await app.sendAndWait('/stop', session.threadId);
    assert.equal(app.store.promptQueue.count(session.id), 0);
    assert.equal(app.store.promptQueue.isPaused(session.id), true);
    const emptyMessage = await app.sendAndWait(`/p ${empty.prompt}`, session.threadId);
    assert.equal(app.store.promptQueue.count(session.id), 1);
    assert.deepEqual(app.omp.provider.requests.get(empty.name), []);
    await app.sendAndWait('/continue', session.threadId);
    await completeWriteTask(app, empty, emptyMessage, session.threadId);
    await app.waitForCondition(() => !app.store.promptQueue.has(session.id));
    const prompts = app.guestFrames.filter(frame => frame.t === 'prompt').length;
    await app.sendAndWait('/continue', session.threadId);
    assert.equal(app.store.promptQueue.isPaused(session.id), false);
    assert.equal(app.guestFrames.filter(frame => frame.t === 'prompt').length, prompts);
    app.omp.provider.assertComplete([seed.name, first.name, second.name, paused.name, empty.name]);
  });

  it('durable queue survives real Telegram redelivery, deferred preparations, and a rejected attachment', { timeout: 360000 }, async t => {
    const seed = createWriteTask('queue-seed');
    const queued = createWriteTask('queue-recovered');
    const following = createWriteTask('queue-after-rejected-document');
    const app = await setupCollaborationTest(t, { scenarios: [seed, queued, following].map(writeScenario) });
    await enrollForum(app);
    const retirement = await installRetirementGate(app);
    const session = await createManagedTopic(app);
    const started = await app.sendAndWait(`/p ${seed.prompt}`, session.threadId);
    await completeWriteTask(app, seed, started, session.threadId);
    const acknowledgementHeld = holdTelegramAcknowledgement(app.bot, () => app.store.promptQueue.has(session.id));
    await retirement.arm(session.id);
    const retiring = app.runtime.retireIdle(0);
    const replayRelease = Promise.withResolvers<void>();
    let replayed = false;
    try {
      await app.waitForCondition(retirement.entered);
      const sent = await app.sendAndWait(`/p /modelpreset e2e-alternate /skill:e2e-review ${queued.prompt}`, session.threadId);
      const update = app.updates.find(value => value.message?.message_id === sent.id);
      assert.ok(update);
      assert.equal(app.store.promptQueue.list(session.id)[0]?.messageId, sent.id);
      assert.deepEqual(app.omp.provider.requests.get(queued.name), []);
      await app.waitForCondition(acknowledgementHeld);
      await retiring;
      await app.restart(bot => {
        bot.use(async (ctx, next) => {
          if (ctx.update.update_id !== update.update_id) { await next(); return; }
          await replayRelease.promise;
          await next();
          replayed = true;
        });
      });
      assert.equal(app.store.promptQueue.list(session.id)[0]?.messageId, sent.id);
      retirement.release();
      await completeWriteTask(app, queued, sent, session.threadId);
      assert.ok(app.omp.provider.requests.get(queued.name)!.every(request => request.model === 'e2e-alternate'));
      assert.ok(taskInput(app.omp.provider, queued).text.includes('/skill:e2e-review'));
      replayRelease.resolve();
      await app.waitForCondition(() => replayed);
      assert.equal(app.store.promptQueue.has(session.id), false);
      assert.equal(app.guestFrames.filter(frame => frame.t === 'prompt' && frame.text.includes(queued.prompt)).length, 1);
    } finally {
      replayRelease.resolve();
      retirement.release();
      await retiring;
    }
    const destination = join(session.cwd, 'src');
    await mkdir(destination);
    const rejected = await sendDocument(app, 'src', Buffer.from('This must not replace a directory.'), {
      threadId: session.threadId, caption: '/p Inspect this attachment only after it is saved.',
    });
    await app.waitForMessageHandled(rejected.id);
    assert.equal((await stat(destination)).isDirectory(), true);
    assert.equal(app.store.promptQueue.has(session.id), false);
    const next = await app.sendAndWait(`/p ${following.prompt}`, session.threadId);
    await completeWriteTask(app, following, next, session.threadId);
    app.omp.provider.assertComplete([seed.name, queued.name, following.name]);
  });

  it('queued validation failures do not block a checkpointed preset after host replacement', { timeout: 240000 }, async t => {
    const seed = createWriteTask('queue-checkpoint-seed');
    const restored = createWriteTask('queue-checkpoint-restored');
    const app = await setupCollaborationTest(t, { scenarios: [seed, restored].map(writeScenario) });
    await enrollForum(app);
    const session = await createManagedTopic(app);
    const started = await app.sendAndWait(`/p ${seed.prompt}`, session.threadId);
    await completeWriteTask(app, seed, started, session.threadId);
    await app.sendAndWait('/p /modelpreset queue-nonexistent Do not execute an invalid preset.', session.threadId);
    assert.equal(app.store.promptQueue.has(session.id), false);
    await app.sendAndWait('/p /skill:queue-nonexistent Do not execute an unavailable skill.', session.threadId);
    assert.equal(app.store.promptQueue.has(session.id), false);
    const name = 'checkpoint-input.txt';
    const destination = join(session.cwd, name);
    await writeFile(destination, 'Original attachment', { mode: 0o444 });
    try {
      const sent = await sendDocument(app, name, Buffer.from('Recovered attachment'), {
        threadId: session.threadId, caption: `/p /modelpreset e2e-alternate ${restored.prompt}`,
      });
      await app.waitForMessageHandled(sent.id);
      const pending = app.store.promptQueue.list(session.id)[0];
      assert.equal(pending?.messageId, sent.id);
      assert.deepEqual(pending?.preparation?.extensions, []);
      assert.equal(pending?.preparation?.preset, 'e2e-alternate');
      assert.deepEqual(app.omp.provider.requests.get(restored.name), []);
      await app.runtime.kill(session);
      await chmod(destination, 0o644);
      await app.restart();
      await completeWriteTask(app, restored, sent, session.threadId);
      assert.ok(app.omp.provider.requests.get(restored.name)!.every(request => request.model === 'e2e-alternate'));
      assert.equal(app.store.promptQueue.has(session.id), false);
      app.omp.provider.assertComplete([seed.name, restored.name]);
    } finally {
      await chmod(destination, 0o644);
    }
  });

  it('initial and subsequent tasks share durable FIFO recovery without repeating preparation', { timeout: 240000 }, async t => {
    const initial = createWriteTask('unified-queue-initial');
    const following = createWriteTask('unified-queue-following');
    const app = await setupCollaborationTest(t, {
      scenarios: [writeScenario(initial), writeReadScenario(following, initial.path)],
    });
    await enrollForum(app);
    const settingsPath = app.omp.agentConfigPath;
    const original = await readFile(settingsPath, 'utf8');
    const invalid = JSON.parse(original);
    invalid.modelPresets['e2e-alternate'].modelRoles.default = 'e2e/missing-model';
    await writeFile(settingsPath, JSON.stringify(invalid));
    try {
      const previous = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
      const filename = 'unified-queue-input.txt';
      const bytes = Buffer.from('Resume both tasks after the same completed worktree preparation.');
      const sent = await sendDocument(app, filename, bytes, {
        caption: `/new /worktree /modelpreset e2e-alternate ${initial.prompt}`,
      });
      await app.waitForMessageHandled(sent.id);
      const session = app.store.listSessions(app.telegram.bot.id).find(candidate => !previous.has(candidate.id));
      assert.ok(session);
      const first = app.store.promptQueue.first(session.id);
      assert.equal(first?.messageId, sent.id);
      assert.equal(first?.state, 'pending');
      // Later intake also wakes recovery if the native host initially refused its idle guard.
      const next = await app.sendAndWait(`/p ${following.prompt}`, session.threadId);
      await app.waitForCondition(() => {
        const extensions = app.store.promptQueue.first(session.id)?.preparation?.extensions;
        return extensions?.length === 1 && extensions[0]?.kind === 'model-preset';
      });
      const prepared = app.store.getSession(session.id)!;
      assert.notEqual(prepared.cwd, app.omp.workspace);
      assert.deepEqual(app.store.promptQueue.list(session.id).map(item => item.messageId), [sent.id, next.id]);
      assert.deepEqual(app.omp.provider.requests.get(initial.name), []);
      assert.deepEqual(app.omp.provider.requests.get(following.name), []);
      await writeFile(settingsPath, original);
      await app.restart();
      await completeWriteTask(app, following, next, session.threadId);
      const recovered = app.store.getSession(session.id)!;
      assert.equal(recovered.cwd, prepared.cwd);
      assert.deepEqual(await readFile(join(recovered.cwd, filename)), bytes);
      assert.deepEqual(JSON.parse(await readFile(join(recovered.cwd, initial.path), 'utf8')), initial.evidence);
      // Reading the first task's unique file through the real tool proves execution order.
      assert.ok(JSON.stringify(taskReadResult(app.omp.provider, following)).includes(initial.evidence.nonce));
      assert.equal(app.guestFrames.filter(frame => frame.t === 'prompt' && frame.text.includes(initial.prompt)).length, 1);
      assert.equal(app.guestFrames.filter(frame => frame.t === 'prompt' && frame.text.includes(following.prompt)).length, 1);
      assert.equal(app.store.promptQueue.has(session.id), false);
      app.omp.provider.assertComplete([initial.name, following.name]);
    } finally {
      await writeFile(settingsPath, original);
    }
  });
}
