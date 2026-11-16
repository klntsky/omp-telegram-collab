import assert from 'node:assert/strict';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { completeWriteTask, createWriteTask, taskInput, writeScenario } from './helpers/model-tasks.js';
import { createManagedTopic, enrollForum, sendDocument } from './helpers/telegram-actions.js';
import { holdTelegramAcknowledgement } from './helpers/telegram-acknowledgement.js';
import { installRetirementGate } from './helpers/retirement-gate.js';

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
