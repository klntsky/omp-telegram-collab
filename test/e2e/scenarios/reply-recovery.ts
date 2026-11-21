import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { Store } from '../../../src/store.js';
import { writeConfig } from '../../../src/config.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, writeScenario } from '../helpers/model-tasks.js';
import { holdTelegramRequest } from '../helpers/telegram-request-gate.js';
import { bounded } from '../helpers/async.js';

const requestPayload = z.object({ message_thread_id: z.number().optional() });
const successfulReply = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) });

export function registerReplyRecovery(): void {
  // Permanent: Committed output must outlive its host, listener, and service owner.
  // Real sends with failed checkpoints must retain cooldowns, while confirmed chunks
  // resume without duplication; unlike receipt recovery, this protects outbound durability.
  test('durable replies survive host exit, listener replacement, and service restart', { timeout: 480000 }, async t => {
    const disconnected = createWriteTask('reply-disconnected', '', 'shutdown-after-turn');
    const replaced = createWriteTask('reply-replaced');
    const restarted = createWriteTask('reply-restarted', '', 'shutdown-after-turn');
    const final = Promise.withResolvers<void>();
    const disconnectedScenario = writeScenario(disconnected);
    const restartScenario = writeScenario(restarted);
    const app = await setupCollaborationTest(t, { scenarios: [
      { ...disconnectedScenario, steps: [disconnectedScenario.steps[0]!, { type: 'text', text: 'Committed disconnected reply.', barrier: final.promise }] },
      writeScenario(replaced),
      { ...restartScenario, steps: [restartScenario.steps[0]!, { type: 'text', text: Array.from({ length: 1400 }, (_, i) => `Recovery evidence line ${i}.`).join('\n') }] },
    ] });
    t.after(() => final.resolve());
    const extension = join(app.omp.dataDir, 'shutdown-after-turn.ts');
    await writeFile(extension, `import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nexport default function (pi) { pi.on('agent_end', async (_event, ctx) => { if (existsSync(join(ctx.cwd, 'shutdown-after-turn'))) ctx.shutdown(); }); }\n`);
    app.config.omp.args.push('--extension', extension);
    writeConfig(app.config);
    await enrollForum(app);

    const first = await createManagedTopic(app);
    const firstBinding = await app.runtime.ensure(first);
    const firstHost = (await app.omp.listHosts()).find(host => host.sessionId === firstBinding.sessionId);
    assert.ok(firstHost);
    const firstSource = await app.runtime.historySource(first);
    assert.ok(firstSource);
    const firstGeneration = app.store.getSessionGeneration(first.id);
    const firstPrompt = await app.sendAndWait(`/p ${disconnected.prompt}`, first.threadId);
    await app.waitForCondition(() => app.omp.provider.requests.get(disconnected.name)!.length === 2);
    const reconnectGuests = app.disconnectGuests();
    final.resolve();
    const firstReply = await completeWriteTask(app, disconnected, firstPrompt, first.threadId);
    await app.waitForCondition(async () => (await app.runtime.resolveExisting(first)) === undefined);
    reconnectGuests();
    assert.equal(await app.runtime.resolveExisting(first), undefined);
    assert.equal(app.store.getSessionGeneration(first.id), firstGeneration);
    assert.deepEqual(await app.runtime.historySource(first), firstSource);
    assert.ok(app.store.getMessageAnchor(first.id, firstSource.sessionId, first.chatId, firstReply.id));
    assert.ok(!(await app.omp.listHosts()).some(host => host.cwd === first.cwd));
    await rm(join(first.cwd, 'shutdown-after-turn'));

    const second = await createManagedTopic(app);
    const binding = await app.runtime.ensure(second);
    assert.ok(binding);
    const gate = holdTelegramRequest(app.bot, (method, payload) => method === 'sendRichMessage' &&
      requestPayload.parse(payload).message_thread_id === second.threadId, t.signal);
    t.after(() => gate.release());
    const secondPrompt = await app.sendAndWait(`/p ${replaced.prompt}`, second.threadId);
    await bounded(gate.entered, t.signal);
    const frames = app.hostFrames.length;
    app.disconnectGuests()();
    await app.service.ensureMirroring(second, binding);
    await app.waitForCondition(() => app.hostFrames.slice(frames).some(frame => frame.t === 'welcome'));
    // Fail local persistence after a real Telegram send; no API response is fabricated.
    app.store.db.exec(`CREATE TEMP TRIGGER reject_reply_checkpoint BEFORE INSERT ON message_anchors
      WHEN NEW.kind='assistant' BEGIN SELECT RAISE(FAIL,'Injected reply checkpoint failure'); END`);
    gate.release();
    const secondReply = await completeWriteTask(app, replaced, secondPrompt, second.threadId);
    await app.waitForCondition(() => app.store.db.prepare('SELECT error FROM replies WHERE session_id=?')
      .get(second.id)?.error === 'Injected reply checkpoint failure' &&
      app.store.replies.retryAfter(second.id) > Date.now());
    const failedAt = performance.now();
    const retryAfter = app.store.replies.retryAfter(second.id);
    assert.equal(app.store.getMessageAnchor(second.id, binding.sessionId, second.chatId, secondReply.id), undefined);
    assert.equal(app.store.replies.pending(second.id)[0]?.nextPart, 0);
    app.store.db.exec('DROP TRIGGER reject_reply_checkpoint');
    app.disconnectGuests()();
    await app.service.ensureMirroring(second, binding);
    await app.restart();
    assert.equal(app.store.replies.retryAfter(second.id), retryAfter);
    const retry = () => app.apiCalls.find(call => {
      if (call.method !== 'sendRichMessage' ||
          requestPayload.parse(call.payload).message_thread_id !== second.threadId) return false;
      const id = successfulReply.parse(call.result).result.message_id;
      return id !== secondReply.id && app.store.getMessageAnchor(second.id, binding.sessionId, second.chatId, id);
    });
    await app.waitForCondition(() => retry() !== undefined, 'reply checkpoint retry', 90000);
    assert.ok(performance.now() - failedAt >= 29000);
    assert.equal(app.store.getMessageAnchor(second.id, binding.sessionId, second.chatId,
      successfulReply.parse(retry()!.result).result.message_id)?.partIndex, 0);
    assert.deepEqual(app.store.replies.pending(second.id), []);
    await app.runtime.stop(second);

    const third = await createManagedTopic(app);
    const thirdBinding = await app.runtime.ensure(third);
    const thirdHost = (await app.omp.listHosts()).find(host => host.sessionId === thirdBinding.sessionId);
    const thirdSource = await app.runtime.historySource(third);
    assert.ok(thirdHost && thirdSource);
    const received = Promise.withResolvers<void>();
    const checkpoint = Promise.withResolvers<void>();
    let held = false;
    t.after(() => checkpoint.resolve());
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      const result = await previous(method, payload, signal);
      if (!held && method === 'sendRichMessage' &&
          requestPayload.parse(payload).message_thread_id === third.threadId) {
        successfulReply.parse(result);
        held = true;
        // Only hold a real successful response. Cancellation releases that known result,
        // allowing confirm() to checkpoint it while shutdown prevents the next API action.
        // Bot API answers only after TDLib's successful-send update; this does not
        // manufacture an acknowledgement or assume an unconfirmed request succeeded.
        // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L14174-L14208
        const release = () => checkpoint.resolve();
        if (signal?.aborted) release();
        else signal?.addEventListener('abort', release, { once: true });
        received.resolve();
        try { await checkpoint.promise; }
        finally { signal?.removeEventListener('abort', release); }
      }
      return result;
    });
    const thirdPrompt = await app.sendAndWait(`/p ${restarted.prompt}`, third.threadId);
    await bounded(received.promise, t.signal);
    await app.waitForCondition(async () => (await app.runtime.resolveExisting(third)) === undefined);
    const pausing = app.pause();
    queueMicrotask(() => checkpoint.resolve());
    await pausing;
    const persisted = new Store(join(app.omp.dataDir, 'telegram.sqlite'));
    let pending;
    try {
      pending = persisted.replies.pending(third.id)[0];
      assert.ok(pending);
      assert.equal(pending.nextPart, 1);
      assert.ok(pending.parts.length > 1);
      assert.equal(pending.replyTo, thirdPrompt.id);
    } finally { persisted.close(); }
    const confirmed = app.apiCalls.filter(call => call.method === 'sendRichMessage' &&
      requestPayload.parse(call.payload).message_thread_id === third.threadId);
    assert.equal(confirmed.length, 1);
    const firstChunkId = successfulReply.parse(confirmed[0]!.result).result.message_id;
    await app.restart();
    assert.equal(app.store.getMessageAnchor(third.id, thirdSource.sessionId, third.chatId, firstChunkId)?.partIndex, 0);
    await app.waitForCondition(() => app.apiCalls.filter(call => call.method === 'sendRichMessage' &&
      requestPayload.parse(call.payload).message_thread_id === third.threadId &&
      app.store.getMessageAnchor(third.id, thirdSource.sessionId, third.chatId,
        successfulReply.parse(call.result).result.message_id)).length === pending.parts.length);
    const chunks = app.apiCalls.filter(call => call.method === 'sendRichMessage' &&
      requestPayload.parse(call.payload).message_thread_id === third.threadId);
    assert.equal(chunks.length, pending.parts.length);
    assert.equal(successfulReply.parse(chunks[0]!.result).result.message_id, firstChunkId);
    for (const [index, chunk] of chunks.entries()) {
      const id = successfulReply.parse(chunk.result).result.message_id;
      const anchor = app.store.getMessageAnchor(third.id, thirdSource.sessionId, third.chatId, id);
      assert.equal(anchor?.entryId, pending.entryId);
      assert.equal(anchor?.partIndex, index);
    }
    await completeWriteTask(app, restarted, thirdPrompt, third.threadId);
    assert.equal(await app.runtime.resolveExisting(third), undefined);
    assert.ok(!(await app.omp.listHosts()).some(host => host.cwd === third.cwd));
    app.omp.provider.assertComplete();
  });
}
