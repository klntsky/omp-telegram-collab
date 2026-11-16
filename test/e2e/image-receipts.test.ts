import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { completeWriteTask, createWriteTask, readSessionHistory, taskInput, writeScenario } from './helpers/model-tasks.js';
import { createManagedTopic, enrollForum, sendPhoto, waitForReactionAttempt } from './helpers/telegram-actions.js';

const receiptEntry = z.object({
  id: z.string(), parentId: z.string().nullable(),
  type: z.literal('custom_message'), customType: z.literal('collab-prompt'),
  content: z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  ])),
});

function imageIdentity(data: string): string {
  return /^blob:sha256:[a-f0-9]{64}$/.test(data)
    ? data.slice('blob:sha256:'.length)
    : createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
}

test('caption-only /p photos retain distinct canonical receipts across restart', { timeout: 300000 }, async t => {
  const tasks = [
    createWriteTask('image-receipts', '', 'first-image-receipt.json'),
    { ...createWriteTask('image-receipts', '', 'second-image-receipt.json'), toolCallId: 'call_e2e_second_image_receipt' },
    { ...createWriteTask('image-receipts', '', 'resumed-image-receipt.json'), toolCallId: 'call_e2e_resumed_image_receipt' },
  ];
  // Route on the latest user's image marker, not text: every caption contains only /p.
  // One scripted conversation supplies successive real write-tool calls without relying on image re-encoding.
  const app = await setupCollaborationTest(t, { scenarios: [{
    name: tasks[0]!.name, prompt: 'data:image/',
    steps: tasks.flatMap(task => writeScenario(task).steps),
  }] });
  await enrollForum(app);
  const session = await createManagedTopic(app);
  const readReceipts = async () => (await readSessionHistory(app.omp.dataDir, session.id))
    .trim().split('\n').flatMap(line => {
      const parsed = receiptEntry.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
  const received: Array<{ messageId: number; entryId: string; image: string }> = [];
  const assets = ['telegram-topics.jpg', 'botfather-mini-app.png', 'telegram-topics.jpg'];
  let replayStart = 0;
  for (const [index, task] of tasks.entries()) {
    if (index === 2) {
      const beforeReplay = await readReceipts();
      replayStart = app.hostFrames.length;
      await app.restart();
      assert.deepEqual(await readReceipts(), beforeReplay);
    }
    const requestIndex = app.omp.provider.requests.get(task.name)?.length ?? 0;
    const bytes = await readFile(new URL(`../../assets/${assets[index]}`, import.meta.url));
    // Telegram's server accepts messagePhoto captions independently of message text:
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp (JsonMessage::store, messagePhoto).
    const sent = await sendPhoto(app, session.threadId, '/p', bytes.toString('base64'));
    await completeWriteTask(app, task, sent, session.threadId);
    await waitForReactionAttempt(app, sent.id, '🤝');
    const input = taskInput(app.omp.provider, task, requestIndex);
    const prompt = app.guestFrames.filter(frame => frame.t === 'prompt').at(-1);
    assert.ok(prompt);
    // The first submission includes Telegram context; follow-ups stay image-only.
    if (index > 0) assert.equal(prompt.text, '');
    assert.equal(input.images.length, 1);
    const image = input.images[0]!;
    assert.match(image, /^data:image\/[^;]+;base64,/);
    const binding = await app.runtime.existingBinding(session);
    assert.ok(binding);
    const anchor = app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, sent.id);
    assert.ok(anchor);
    assert.equal(anchor.kind, 'collab-prompt');
    assert.equal(app.store.getReplyTarget(session.id), sent.id);
    const canonical = (await readReceipts()).find(entry => entry.id === anchor.entryId);
    assert.ok(canonical);
    assert.equal(canonical.parentId, anchor.parentEntryId);
    assert.equal(canonical.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), prompt.text);
    const images = canonical.content.filter(part => part.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(imageIdentity(images[0]!.data), imageIdentity(image.slice(image.indexOf(',') + 1)));
    received.push({ messageId: sent.id, entryId: anchor.entryId, image });
  }
  assert.notEqual(received[0]!.entryId, received[1]!.entryId);
  assert.notEqual(received[0]!.image, received[1]!.image);
  const replayed = app.hostFrames.slice(replayStart)
    .flatMap(frame => frame.t === 'snapshot-chunk' ? frame.entries.map(entry => entry.id) : []);
  for (const receipt of received.slice(0, 2)) assert.ok(replayed.includes(receipt.entryId));
  const binding = await app.runtime.existingBinding(session);
  assert.ok(binding);
  for (const receipt of received) {
    assert.equal(app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, receipt.messageId)?.entryId, receipt.entryId);
  }
  assert.equal(app.store.getReplyTarget(session.id), received[2]!.messageId);
  app.omp.provider.assertComplete();
});