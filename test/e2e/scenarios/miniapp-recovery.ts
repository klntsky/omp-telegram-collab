import assert from 'node:assert/strict';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, writeScenario } from '../helpers/model-tasks.js';
import { observeBrowser } from '../helpers/browser-observer.js';
import test from 'node:test';

export function registerMiniAppRecovery(): void {
// Provision the short independent case after the long shared workflows: consecutive
// forum creations produced live FLOOD_WAIT_40, beyond the unchanged 30-second RPC budget.
// TDLib also accounts server-requested delays against a total query budget:
// https://github.com/tdlib/td/blob/master/td/telegram/net/NetQueryDelayer.cpp (NetQueryDelayer::delay).
test('Mini App retries a Collab room closed during gateway setup', {timeout: 480000}, async t => {
  const task = createWriteTask('miniapp-setup-recovery');
  const app = await setupCollaborationTest(t, {scenarios: [writeScenario(task)]});
  await enrollForum(app);
  const session = await createManagedTopic(app);
  const generation = app.store.getSessionGeneration(session.id);
  const browser = await observeBrowser(t, app, session, {interruptSetup: app.omp.interruptNextGuest});
  assert.ok(browser.recovery.phases.has('reconnecting'));
  assert.ok(!browser.recovery.phases.has('ended'));
  assert.equal(browser.recovery.authorizationRefreshes, 1);
  await browser.denyMutations();
  const sent = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
  await completeWriteTask(app, task, sent, session.threadId);
  await browser.waitForSnapshot(snapshot => JSON.stringify(snapshot.entries).includes(task.toolCallId));
  assert.equal(app.store.getSessionGeneration(session.id), generation);
  await app.sendAndWait('/kill', session.threadId);
  await browser.waitForSnapshot(snapshot => snapshot.phase === 'ended');
  assert.ok(app.store.getSessionGeneration(session.id) > generation);
});
}
