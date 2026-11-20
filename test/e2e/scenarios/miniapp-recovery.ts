import assert from 'node:assert/strict';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, writeScenario } from '../helpers/model-tasks.js';
import { observeBrowser } from '../helpers/browser-observer.js';
import { interruptManagedRelay } from '../helpers/relay.js';
import test from 'node:test';

export function registerMiniAppRecovery(): void {
// Provision the short independent case after the long shared workflows:
// consecutive forum creations produced account-wide FLOOD_WAIT_40 cooldowns.
// TDLib also accounts server-requested delays against a total query budget:
// https://github.com/tdlib/td/blob/master/td/telegram/net/NetQueryDelayer.cpp (NetQueryDelayer::delay).
test('Mini App recovers when the managed local relay stops during gateway setup', {timeout: 480000}, async t => {
  const task = createWriteTask('miniapp-setup-recovery');
  const app = await setupCollaborationTest(t, {scenarios: [writeScenario(task)]});
  await enrollForum(app);
  const session = await createManagedTopic(app);
  const generation = app.store.getSessionGeneration(session.id);
  const before = await app.runtime.ensure(session);
  const host = (await app.omp.listHosts()).find(value => value.sessionId === before.sessionId)!;
  const browser = await observeBrowser(t, app, session, {interruptSetup: () => interruptManagedRelay(app.omp.dataDir)});
  assert.ok(browser.recovery.phases.has('reconnecting'));
  assert.ok(!browser.recovery.phases.has('ended'));
  const after = await app.runtime.ensure(session);
  assert.equal(after.sessionId, before.sessionId);
  assert.equal((await app.omp.listHosts()).find(value => value.sessionId === after.sessionId)?.pid, host.pid);
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
