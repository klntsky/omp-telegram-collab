import assert from 'node:assert/strict';
import { CollabTransportError } from '../../../src/collab.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, writeScenario } from '../helpers/model-tasks.js';
import { observeBrowser } from '../helpers/browser-observer.js';
import test from 'node:test';

export function registerMiniAppRecovery(): void {
test('Mini App retries a Collab room closed during gateway setup', {timeout: 480000}, async t => {
  const task = createWriteTask('miniapp-setup-recovery');
  const app = await setupCollaborationTest(t, {scenarios: [writeScenario(task)]});
  await enrollForum(app);
  const session = await createManagedTopic(app);
  const generation = app.store.getSessionGeneration(session.id);
  const browser = await observeBrowser(t, app, session, {interruptSetup: app.omp.interruptNextGuest});
  assert.ok(browser.recovery.phases.has('reconnecting'));
  assert.ok(!browser.recovery.phases.has('ended'));
  assert.ok(browser.recovery.interruptedSetupFailure instanceof CollabTransportError);
  await browser.denyMutations();
  const sent = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
  await completeWriteTask(app, task, sent, session.threadId);
  await browser.waitForSnapshot(snapshot => snapshot.phase === 'live' && !snapshot.working &&
    snapshot.entries.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
      entry.message.toolCallId === task.toolCallId && entry.message.toolName === 'write' && !entry.message.isError));
  assert.equal(app.store.getSessionGeneration(session.id), generation);
  await app.sendAndWait('/kill', session.threadId);
  await browser.waitForSnapshot(snapshot => snapshot.phase === 'ended');
  assert.ok(app.store.getSessionGeneration(session.id) > generation);
});
}
