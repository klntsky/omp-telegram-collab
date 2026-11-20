import assert from 'node:assert/strict';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, enrollForum, waitForPanel } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, questionScenario, writeScenario } from '../helpers/model-tasks.js';
import { observeBrowser } from '../helpers/browser-observer.js';
import { interruptManagedRelay } from '../helpers/relay.js';
import test from 'node:test';
import { SessionRetiringError } from '../../../src/runtime/types.js';
import { waitUntil } from '../helpers/async.js';

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
test('Mini App observes draining work across restart without reopening mutation admission', {timeout: 480000}, async t => {
  const task = createWriteTask('miniapp-draining-work');
  const app = await setupCollaborationTest(t, {scenarios: [questionScenario(task)]});
  await enrollForum(app);
  const session = await createManagedTopic(app);
  const generation = app.store.getSessionGeneration(session.id);
  const start = app.apiCalls.length;
  const instruction = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
  await waitForPanel(app, 'question', 'ask:', start, session.threadId);
  const binding = await app.runtime.ensure(session);
  const host = (await app.omp.listHosts()).find(value => value.sessionId === binding.sessionId)!;
  assert.ok(host);
  // Explicit retirement drains an admitted ask instead of cancelling it. The
  // service must still let a reader observe that work after adopting the host.
  assert.equal(await app.runtime.stop(session), false);
  const restored = app.apiCalls.length;
  await app.restart();
  await assert.rejects(app.runtime.ensure(session), SessionRetiringError);
  assert.throws(() => app.runtime.retain(session.id), SessionRetiringError);
  assert.throws(() => app.runtime.markPrompt(session.id), SessionRetiringError);
  const browser = await observeBrowser(t, app, session);
  await browser.denyMutations();
  assert.equal((await app.omp.listHosts()).find(value => value.sessionId === host.sessionId)?.pid, host.pid);
  const question = await waitForPanel(app, 'question', 'ask:', restored, session.threadId);
  await clickPanel(app, question, 1);
  await completeWriteTask(app, task, instruction, session.threadId);
  await waitUntil(() => app.omp.listHosts(), hosts => !hosts.some(value => value.pid === host.pid),
    AbortSignal.any([t.signal, AbortSignal.timeout(60000)]));
  assert.equal(app.store.getSessionGeneration(session.id), generation);
});
}
