import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import type { BotComponents } from '../../../src/bot/composition.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { bounded } from '../helpers/async.js';
import { completeWriteTask } from '../helpers/model-tasks.js';
import { createManagedTopic, deliveredPanels, replyText, submitCallback, waitForEditor, waitForPanel } from '../helpers/telegram-actions.js';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerQuestionReconnectAnswer(getApp: () => CollaborationTest, task: WorkflowTasks['questionReconnectAnswer']): void {
  it('question answer during reconnect readiness', async t => {
    const app = getApp();
    const session = await createManagedTopic(app);
    const start = app.apiCalls.length;
    const frameStart = app.hostFrames.length;
    const guestStart = app.guestFrames.length;
    const instruction = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
    const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
    const select = app.hostFrames.slice(frameStart).findLast(frame => frame.t === 'ui-request');
    assert.ok(select?.t === 'ui-request' && select.request.kind === 'select');
    const originalDeliveries = deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId);
    const reconnectStart = app.hostFrames.length;
    let held = false;
    let released = false;
    let disabled = false;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: readyRead, resolve: entered } = Promise.withResolvers<void>();
    const replaySeen = () => app.hostFrames.slice(reconnectStart).some(frame =>
      frame.t === 'ui-request' && frame.request.reqId === select.request.reqId);
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      const matching = z.object({ chat_id: z.literal(session.chatId) }).safeParse(payload).success;
      if (!disabled && !held && method === 'getChat' && matching && replaySeen()) {
        held = true;
        const result = await previous(method, payload, signal);
        entered();
        await gate;
        return result;
      }
      return previous(method, payload, signal);
    });
    const deadline = AbortSignal.any([t.signal, AbortSignal.timeout(30000)]);
    try {
      assert.equal(app.omp.disconnectGuests(), 1);
      await app.waitForCondition(() => {
        const frames = app.hostFrames.slice(reconnectStart);
        const replay = frames.findIndex(frame => frame.t === 'ui-request' && frame.request.reqId === select.request.reqId);
        return replay >= 0 && frames.slice(replay + 1).some(frame =>
          frame.t === 'event' && frame.event.type === 'notice' && frame.event.source === 'collab' &&
          frame.event.message === `Telegram @${app.bot.botInfo.username} joined the collab session`);
      });
      await bounded(readyRead, deadline);
      const components: BotComponents = Reflect.get(app.service, 'components');
      const listener = components.connections.listeners.get(session.id);
      assert.ok(listener);
      const editorStart = app.apiCalls.length;
      await submitCallback(app, panel, panel.buttons[2]!);
      await app.waitForCondition(() =>
        app.guestFrames.slice(guestStart).some(frame => frame.t === 'ui-response' && frame.reqId === select.request.reqId && frame.value === 'Other (type your own)') &&
        app.hostFrames.slice(reconnectStart).some(frame => frame.t === 'ui-request-end' && frame.reqId === select.request.reqId));
      assert.equal(released, false, 'select must end while replay readiness is still held');
      release();
      released = true;
      await bounded(listener.tail, deadline);
      const editorMessageId = await waitForEditor(app, editorStart, session.threadId);
      const editor = app.hostFrames.slice(reconnectStart).findLast(frame => frame.t === 'ui-request' && frame.request.kind === 'editor');
      assert.ok(editor?.t === 'ui-request' && editor.request.kind === 'editor');
      const deliveries = deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId);
      const topicSend = z.object({ method: z.literal('sendMessage'), payload: z.object({ message_thread_id: z.literal(session.threadId) }) });
      const extraSends = app.apiCalls.slice(editorStart).filter(call => topicSend.safeParse(call).success);
      const answer = 'Custom answer submitted during reconnect readiness';
      await replyText(app, editorMessageId, session.threadId, answer);
      await completeWriteTask(app, task, instruction, session.threadId);
      assert.equal(editorMessageId, panel.messageId, 'editor must retain the original select control after readiness resumes');
      assert.deepEqual(new Set(deliveries.map(delivery => delivery.messageId)),
        new Set(originalDeliveries.map(delivery => delivery.messageId)),
        'reconnect must not deliver replacement question controls');
      assert.equal(extraSends.length, 0, 'reconnect answer must reuse the original body and control messages');
      const selectResponses = app.guestFrames.slice(guestStart).filter(frame => frame.t === 'ui-response' && frame.reqId === select.request.reqId);
      const editorResponses = app.guestFrames.slice(guestStart).filter(frame => frame.t === 'ui-response' && frame.reqId === editor.request.reqId);
      assert.equal(selectResponses.length, 1);
      assert.equal(editorResponses.length, 1);
      assert.ok(editorResponses[0]?.t === 'ui-response' && editorResponses[0].value === answer);
      app.omp.provider.assertComplete([task.name]);
    } finally {
      disabled = true;
      release();
      t.diagnostic(`question reconnect readiness: held=${held}, releasedBeforeCleanup=${released}, replaySeen=${replaySeen()}, selectReqId=${select.request.reqId}, originalControl=${panel.messageId}`);
    }
  });
}
