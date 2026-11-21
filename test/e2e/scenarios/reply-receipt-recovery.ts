import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { readReplyHistory } from '../../../src/bot/reply-history.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { bounded } from '../helpers/async.js';
import { createManagedTopic, enrollForum } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, writeScenario } from '../helpers/model-tasks.js';

const delivered = z.object({
  method: z.literal('sendRichMessage'),
  payload: z.object({ message_thread_id: z.number() }),
  result: z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) }),
});

export function registerReplyReceiptRecovery(): void {
  // Permanent: Losing the live prompt receipt must not lose the Telegram reply origin.
  // Actual native history must recover both anchors and the delivered reply relationship
  // before reconnect, independently of baseline persistence or outbound chunk retries.
  test('history recovery correlates a prompt receipt missed before ingestion to the originating Telegram message', { timeout: 240000 }, async t => {
    const task = createWriteTask('reply-missed-receipt');
    const model = Promise.withResolvers<void>();
    let resume: (() => void) | undefined;
    let closing = false;
    t.after(() => { closing = true; model.resolve(); resume?.(); });
    const scenario = writeScenario(task);
    const app = await setupCollaborationTest(t, { scenarios: [{ ...scenario, steps: [
      scenario.steps[0]!,
      { type: 'text', text: 'The requested file has been written.', barrier: model.promise },
    ] }] });
    await enrollForum(app);
    const session = await createManagedTopic(app);
    const binding = await app.runtime.ensure(session);
    await app.service.ensureMirroring(session, binding);
    await app.waitForCondition(() => app.store.hasSnapshot(session.id));
    const source = await app.runtime.historySource(session);
    assert.ok(source);
    const interrupted = app.interruptNextPromptReceipt().then(reconnect => {
      resume = reconnect;
      if (closing) reconnect();
    });
    const sent = await app.send(`/p ${task.prompt}`, session.threadId);
    await app.waitForCondition(() => resume !== undefined);
    await bounded(interrupted, t.signal);
    const promptFrame = app.hostFrames.findLast(frame => frame.t === 'entry' &&
      frame.entry.type === 'custom_message' && frame.entry.customType === 'collab-prompt');
    assert.ok(promptFrame?.t === 'entry');
    const prompt = promptFrame.entry;

    // Native #handlePrompt dispatches promptCustomMessage independently of the peer;
    // #handlePeerLeft only drops identity/UI, not the accepted generation:
    // https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/collab/host.ts#L1131-L1163
    // https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/collab/host.ts#L1229-L1239
    await app.waitForTaskStarted(task.name);
    model.resolve();
    let assistantId: string | undefined;
    let assistantParent: string | null | undefined;
    await app.waitForCondition(async () => {
      const entries = await readReplyHistory(source);
      const answer = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
        entry.message.content.some(part => part.type === 'text' && part.text.trim().length > 0));
      if (!answer) return false;
      assistantId = answer.id;
      assistantParent = answer.parentId;
      return true;
    });
    // Keep reconnect gated until history recovery has actually sent the final native entry.
    let replyId: number | undefined;
    await app.waitForCondition(() => app.apiCalls.some(call => {
      const parsed = delivered.safeParse(call);
      if (!parsed.success || parsed.data.payload.message_thread_id !== session.threadId) return false;
      const id = parsed.data.result.result.message_id;
      const anchor = app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, id);
      if (anchor?.entryId !== assistantId) return false;
      replyId = id;
      return true;
    }));
    const [reply] = await bounded(app.telegram.user.client.getMessages(session.chatId, replyId!), t.signal);
    assert.ok(reply);
    assert.equal(reply.replyToMessage?.id, sent.id);
    assert.equal(reply.replyToMessage?.threadId, session.threadId);
    const promptAnchor = app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, sent.id);
    assert.equal(promptAnchor?.kind, 'collab-prompt');
    assert.equal(promptAnchor?.entryId, prompt.id);
    assert.equal(promptAnchor?.parentEntryId, prompt.parentId);
    const assistantAnchor = app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, reply.id);
    assert.equal(assistantAnchor?.kind, 'assistant');
    assert.equal(assistantAnchor?.entryId, assistantId);
    assert.equal(assistantAnchor?.parentEntryId, assistantParent);
    await completeWriteTask(app, task, sent, session.threadId);
    resume!();
  });
}
