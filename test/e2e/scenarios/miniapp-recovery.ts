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
// Permanent: A relay lost during gateway setup must reconnect to the same live host,
// not end the viewer or advance its generation; explicit /kill must still end it.
// Unlike draining recovery, this distinguishes transient setup loss from terminal shutdown.
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
// Permanent: Restarted draining hosts must remain readable without admitting new writes.
// Relay recovery and rejected queued work must preserve the existing feed until admitted
// work finishes, unlike the active-host setup recovery case above.
test('Mini App observes draining work across restart without reopening mutation admission', {timeout: 480000}, async t => {
  const task = createWriteTask('miniapp-draining-work');
  const nextTask = createWriteTask('miniapp-after-draining');
  const app = await setupCollaborationTest(t, {scenarios: [questionScenario(task), writeScenario(nextTask)]});
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
  await waitForPanel(app, 'question', 'ask:', restored, session.threadId);
  let reconnected = app.apiCalls.length;
  const browser = await observeBrowser(t, app, session, {
    interruptSetup: async () => {
      reconnected = app.apiCalls.length;
      await interruptManagedRelay(app.omp.dataDir);
    },
  });
  assert.ok(browser.recovery.phases.has('reconnecting'));
  assert.ok(!browser.recovery.phases.has('ended'));
  await browser.denyMutations();
  assert.equal((await app.omp.listHosts()).find(value => value.sessionId === host.sessionId)?.pid, host.pid);
  const disconnects: string[] = [];
  const feed = await app.service.subscribeSessionFeed(session, {
    onFrame: () => {},
    onClose: reason => disconnects.push(reason),
  });
  t.after(() => feed.close());
  const queued = await app.sendAndWait(`/p ${nextTask.prompt}`, session.threadId);
  const pending = app.store.promptQueue.first(session.id);
  assert.equal(pending?.messageId, queued.id);
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.submissionId, undefined);
  assert.deepEqual(disconnects, [], 'Rejected new work must preserve the existing session feed');
  assert.equal(browser.client.getSnapshot().phase, 'live');
  feed.close();
  // The retirement assertions concern this host, not the viewer's normal
  // reconnect-and-resume behavior after a host has fully exited.
  browser.client.close();
  // Relay recovery ends the old question controls and republishes the same
  // pending native request. Answer the current control, not its stale copy.
  const question = await waitForPanel(app, 'question', 'ask:', reconnected, session.threadId);
  await clickPanel(app, question, 1);
  await completeWriteTask(app, task, instruction, session.threadId);
  await waitUntil(() => app.omp.listHosts(), hosts => !hosts.some(value => value.pid === host.pid),
    AbortSignal.any([t.signal, AbortSignal.timeout(60000)]));
  assert.equal(app.store.getSessionGeneration(session.id), generation);
  await completeWriteTask(app, nextTask, queued, session.threadId);
  assert.equal(app.store.promptQueue.first(session.id), undefined);
});
}
