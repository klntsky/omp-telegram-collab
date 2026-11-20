import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import { z } from 'zod';
import { connectCollab } from '../../../src/collab.js';
import { readReplyHistory } from '../../../src/bot/reply-history.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum, waitForBackgroundCompletion } from '../helpers/telegram-actions.js';
import { createWriteTask, writeScenario } from '../helpers/model-tasks.js';

const replyCall = z.object({
  method: z.literal('sendRichMessage'),
  payload: z.object({ message_thread_id: z.number() }),
  result: z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) }),
});

export function registerReplyBaselineRecovery(): void {
  test('unchanged native history retries a failed baseline before delivering new output', { timeout: 480000 }, async t => {
    const initial = createWriteTask('baseline-historical');
    const subsequent = createWriteTask('baseline-new-output');
    const app = await setupCollaborationTest(t, { scenarios: [writeScenario(initial), writeScenario(subsequent)] });
    await enrollForum(app);
    const session = await createManagedTopic(app);
    app.store.db.exec(`CREATE TEMP TRIGGER reject_snapshot_baseline BEFORE INSERT ON snapshot_baselines
      BEGIN SELECT RAISE(FAIL,'Injected snapshot baseline failure'); END`);
    const binding = await app.runtime.ensure(session);
    const pendingTitle = app.store.getPendingSessionTitle(session.id);
    assert.equal(typeof pendingTitle, 'string');
    assert.ok(pendingTitle);
    await app.runtime.setSessionTitle(session, pendingTitle);
    // Observe the actual matching native title through the bot's welcome handler.
    // That acknowledges the human rename before the final snapshot fails its INSERT;
    // neither the pending title nor the history baseline is cleared by the test.
    await assert.rejects(app.service.ensureMirroring(session, binding), /Injected snapshot baseline failure/);
    const resume = app.disconnectGuests();
    t.after(resume);
    const welcomes = app.hostFrames.filter(frame => frame.t === 'welcome').length;
    assert.equal(app.store.hasSnapshot(session.id), false);
    assert.equal(app.store.getPendingSessionTitle(session.id), undefined);
    const frames: HostFrame[] = [];
    const client = await connectCollab(binding, 'baseline-regression', {
      onFrame(frame) { frames.push(frame); },
      onClose(reason) { app.omp.log('native.baseline.close', { sessionId: session.id, reason }); },
    }, t.signal);
    t.after(() => client.close());

    // Native v19's host routes real writable guest prompts through promptCustomMessage,
    // persisting collab-prompt attribution and running the native agent/tools:
    // https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/collab/host.ts#L1137-L1168
    async function runNativeTask(task: typeof initial): Promise<string> {
      const start = frames.length;
      client.send({ t: 'prompt', text: task.prompt });
      await app.waitForTaskStarted(task.name);
      await app.waitForCondition(() => frames.slice(start).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'),
        `native ${task.name} completion`, 60000);
      assert.deepEqual(JSON.parse(await readFile(join(session.cwd, task.path), 'utf8')), task.evidence);
      const source = await app.runtime.historySource(session);
      assert.ok(source);
      const entries = await readReplyHistory(source);
      const output = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
        entry.message.content.some(part => part.type === 'text'));
      assert.ok(output);
      return output.id;
    }

    const initialEntry = await runNativeTask(initial);
    await app.waitForCondition(() => app.store.db.prepare('SELECT state FROM replies WHERE session_id=? AND entry_id=?')
      .get(session.id, initialEntry)?.state === 'done',
    'initial historical capture fails baseline persistence', 100000);
    assert.equal(app.store.hasSnapshot(session.id), false);
    assert.equal(app.store.replies.retryAfter(session.id), 0);
    const source = await app.runtime.historySource(session);
    assert.ok(source);
    const beforeRetry = await stat(source.path, { bigint: true });
    app.store.db.exec('DROP TRIGGER reject_snapshot_baseline');

    const retrySince = Date.now();
    // A welcome snapshot would independently commit the baseline, so keep native
    // admission disconnected while observing the history worker's retry.
    await waitForBackgroundCompletion(app, `reply-delivery:${session.id}`, {since: retrySince, timeoutMs: 100000});
    await app.waitForCondition(() => app.store.hasSnapshot(session.id), 'history baseline retry commits without a delivery cooldown', 100000);
    const afterRetry = await stat(source.path, { bigint: true });
    assert.equal(afterRetry.size, beforeRetry.size);
    assert.equal(afterRetry.mtimeNs, beforeRetry.mtimeNs);
    assert.equal(app.hostFrames.filter(frame => frame.t === 'welcome').length, welcomes);

    // Do not stop at the missing baseline: demonstrate the user-visible loss when a
    // later real native completion would otherwise be misclassified as historical.
    const subsequentEntry = await runNativeTask(subsequent);
    assert.notEqual(subsequentEntry, initialEntry);
    await app.waitForCondition(() => app.apiCalls.some(call => {
      const parsed = replyCall.safeParse(call);
      if (!parsed.success || parsed.data.payload.message_thread_id !== session.threadId) return false;
      return app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId,
        parsed.data.result.result.message_id)?.entryId === subsequentEntry;
    }), 'new native output is delivered and anchored after baseline retry', 100000);
    assert.equal(app.store.hasSnapshot(session.id), true);
    assert.equal(app.store.db.prepare('SELECT parts FROM replies WHERE session_id=? AND entry_id=?')
      .get(session.id, initialEntry)?.parts, '[]');
    app.omp.provider.assertComplete();
  });
}
