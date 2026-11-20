import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from './helpers/telegram-actions.js';

test('provider diagnostics survive empty output and reconnect with partial output without duplicate delivery', { timeout: 360000 }, async t => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const emptyDiagnostic = 'E2E empty provider failure: invalid request <details> & `literal`';
  const partialDiagnostic = 'E2E partial provider failure: invalid request\nsecond diagnostic line';
  const partialText = 'Partial generated response before the provider failed.';
  const app = await setupCollaborationTest(t, { scenarios: [
    { name: 'provider-empty-error', prompt: 'Exercise empty provider failure', steps: [{ type: 'error', message: emptyDiagnostic }] },
    { name: 'provider-offline-error', prompt: 'Exercise offline provider failure', steps: [{ type: 'error', message: partialDiagnostic, partialText, release: release.promise }] },
  ] });
  await enrollForum(app);
  const session = await createManagedTopic(app);
  const empty = await app.sendAndWait('/p Exercise empty provider failure', session.threadId);
  const emptyReply = await app.waitForReply({ replyToMessageId: empty.id, threadId: session.threadId });
  const offline = await app.sendAndWait('/p Exercise offline provider failure', session.threadId);
  await app.waitForTaskStarted('provider-offline-error');
  await app.pause();
  release.resolve();
  await app.restart();
  const recovered = await app.waitForReply({ replyToMessageId: offline.id, threadId: session.threadId });
  const welcome = app.hostFrames.findLast(frame => frame.t === 'welcome');
  assert.ok(welcome?.t === 'welcome');
  const failedEntries = app.hostFrames.flatMap(frame => frame.t === 'entry' ? [frame.entry] : frame.t === 'snapshot-chunk' ? frame.entries : [])
    .filter(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error');
  assert.ok(failedEntries.length >= 2);
  await app.waitForCondition(() => failedEntries.every(entry => app.store.hasReply(session.id, welcome.header.id, entry.id)));
  const emptyEntry = failedEntries.find(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.errorMessage?.includes(emptyDiagnostic));
  const partialEntry = failedEntries.find(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.errorMessage?.includes(partialDiagnostic));
  assert.ok(emptyEntry?.type === 'message' && emptyEntry.message.role === 'assistant');
  assert.ok(partialEntry?.type === 'message' && partialEntry.message.role === 'assistant');
  assert.deepEqual(emptyEntry.message.content, []);
  assert.equal(partialEntry.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), partialText);
  await app.waitForCondition(() => app.store.getMessageAnchor(session.id, welcome.header.id, emptyReply.chat.id, emptyReply.id) !== undefined &&
    app.store.getMessageAnchor(session.id, welcome.header.id, recovered.chat.id, recovered.id) !== undefined);
  assert.equal(app.store.getMessageAnchor(session.id, welcome.header.id, emptyReply.chat.id, emptyReply.id)?.entryId, emptyEntry.id);
  assert.equal(app.store.getMessageAnchor(session.id, welcome.header.id, recovered.chat.id, recovered.id)?.entryId, partialEntry.id);
  const before = app.apiCalls.filter(call => call.method === 'sendRichMessage').length;
  const frameStart = app.hostFrames.length;
  await app.restart();
  await app.waitForCondition(() => app.hostFrames.slice(frameStart).some(frame => frame.t === 'snapshot-chunk' && frame.final));
  assert.equal(app.apiCalls.filter(call => call.method === 'sendRichMessage').length, before);
  app.omp.provider.assertComplete(['provider-empty-error', 'provider-offline-error']);
});
