import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeConfig } from '../../../src/config.js';
import { readReplyHistory } from '../../../src/bot/reply-history.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum } from '../helpers/telegram-actions.js';

export function registerProviderFailure(): void {
test('provider diagnostics survive empty output and reconnect with partial output without duplicate delivery', { timeout: 360000 }, async t => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const emptyDiagnostic = 'E2E empty provider failure: invalid request <details> & `literal`';
  const partialDiagnostic = 'E2E partial provider failure: invalid request\nsecond diagnostic line';
  const partialText = 'Partial generated response before the provider failed.';
  const app = await setupCollaborationTest(t, { scenarios: [
    { name: 'provider-empty-error', prompt: 'Exercise empty provider failure', steps: [{ type: 'error', message: emptyDiagnostic }] },
    { name: 'provider-offline-error', prompt: 'Exercise offline provider failure', steps: [{ type: 'error', message: partialDiagnostic, partialText, release: release.promise }] },
    { name: 'provider-success-after-error', prompt: 'Exercise successful provider recovery', steps: [{ type: 'text', text: 'Successful response after the failed provider attempt.' }] },
  ] });
  const extension = join(app.omp.dataDir, 'provider-shutdown.ts');
  await writeFile(extension, `import { access } from 'node:fs/promises';
import { join } from 'node:path';
export default function (pi) {
  pi.on('agent_end', async (_event, ctx) => {
    try { await access(join(ctx.cwd, 'shutdown-after-provider-error')); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    ctx.shutdown();
  });
}
`);
  app.config.omp.args.push('--extension', extension);
  writeConfig(app.config);
  await enrollForum(app);
  const stickers = await app.telegram.api.getForumTopicIconStickers();
  const finishedIcon = stickers.find(sticker => sticker.emoji === app.topicActivityEmojis.finished)?.custom_emoji_id;
  assert.ok(finishedIcon);
  const session = await createManagedTopic(app);
  const nativeSessionId = (await app.runtime.ensure(session)).sessionId;
  const empty = await app.sendAndWait('/p Exercise empty provider failure', session.threadId);
  const emptyReply = await app.waitForReply({ replyToMessageId: empty.id, threadId: session.threadId });
  await writeFile(join(session.cwd, 'shutdown-after-provider-error'), '');
  const offline = await app.sendAndWait('/p Exercise offline provider failure', session.threadId);
  await app.waitForTaskStarted('provider-offline-error');
  await app.pause();
  release.resolve();
  await app.waitForCondition(async () => !(await app.omp.listHosts()).some(host => host.sessionId === nativeSessionId), 'failed provider host shutdown');
  const recoveryStart = app.apiCalls.length;
  await app.restart();
  const recovered = await app.waitForReply({ replyToMessageId: offline.id, threadId: session.threadId });
  assert.equal(await app.runtime.resolveExisting(session), undefined);
  const source = await app.runtime.historySource(session);
  assert.ok(source);
  const welcome = app.hostFrames.findLast(frame => frame.t === 'welcome');
  assert.ok(welcome?.t === 'welcome');
  const failedEntries = (await readReplyHistory(source))
    .filter(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error');
  assert.ok(failedEntries.length >= 2);
  await app.waitForCondition(() => failedEntries.every(entry =>
    app.store.db.prepare("SELECT 1 FROM replies WHERE session_id=? AND omp_session_id=? AND entry_id=? AND state='done'")
      .get(session.id, welcome.header.id, entry.id) !== undefined));
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
  await app.service.ensureMirroring(session, await app.runtime.ensure(session));
  await app.waitForCondition(() => app.hostFrames.slice(frameStart).some(frame => frame.t === 'snapshot-chunk' && frame.final));
  assert.equal(app.apiCalls.filter(call => call.method === 'sendRichMessage').length, before);
  const iconPayload = z.object({ message_thread_id: z.number(), icon_custom_emoji_id: z.string().optional() });
  const publishedFinished = (start: number) => app.apiCalls.slice(start).some(call => {
    const parsed = iconPayload.safeParse(call.payload);
    return call.method === 'editForumTopic' && parsed.success &&
      parsed.data.message_thread_id === session.threadId && parsed.data.icon_custom_emoji_id === finishedIcon;
  });
  assert.equal(publishedFinished(recoveryStart), false);
  await rm(join(session.cwd, 'shutdown-after-provider-error'));
  const successStart = app.apiCalls.length;
  const success = await app.sendAndWait('/p Exercise successful provider recovery', session.threadId);
  await app.waitForReply({ replyToMessageId: success.id, threadId: session.threadId });
  await app.waitForCondition(() => publishedFinished(successStart), 'successful provider completion icon');
  app.omp.provider.assertComplete(['provider-empty-error', 'provider-offline-error', 'provider-success-after-error']);
});
}
