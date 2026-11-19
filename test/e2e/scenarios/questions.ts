import assert from 'node:assert/strict';
import { z } from 'zod';
import { readConfig } from '../../../src/config.js';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, deliveredPanels, openPanel, replyText, submitCallback, waitForEditor, waitForPanel, waitForReactionAttempt } from '../helpers/telegram-actions.js';
import { completeWriteTask } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks, WorkflowControls } from './workflow-tasks.js';
import { reconnectQuestionTransport } from '../helpers/collaboration-observer.js';

export function registerQuestions(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'question' | 'customAnswer' | 'askHandoff' | 'chatHandoff'>, controls: WorkflowControls): void {
  it('questions', async t => {
    const app = getApp();
    const { interrupted, cancelledQuestion, questionControls } = controls;
    const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
    const session = await createManagedTopic(app);
    const interruptedFrames = app.hostFrames.length;
    await app.sendAndWait(`/p ${interrupted.prompt}`, session.threadId);
    await app.omp.provider.waitForRequest(interrupted.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
    const activeStop = await app.sendAndWait('/stop', session.threadId);
    await app.omp.provider.waitForAbort(interrupted.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
    await waitForReactionAttempt(app, activeStop.id, '🤝');
    await app.waitForCondition(() => app.hostFrames.slice(interruptedFrames).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
    assert.equal(await app.runtime.isRunning(session), true);
  
    for (const task of [tasks.question, tasks.customAnswer]) {
      const start = app.apiCalls.length;
      const questionFrames = app.hostFrames.length;
      const instruction = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
      const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
      const select = app.hostFrames.slice(questionFrames).findLast(frame => frame.t === 'ui-request');
      assert.ok(select?.t === 'ui-request' && select.request.kind === 'select');
      const originalDeliveries = deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId);
      const reconnect = async (reqId: number) => {
        const reconnectStart = app.apiCalls.length;
        await reconnectQuestionTransport(app, session, reqId);
        assert.deepEqual(deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId), originalDeliveries);
        const topicSend = z.object({
          method: z.literal('sendMessage'),
          payload: z.object({ message_thread_id: z.literal(session.threadId) }),
        });
        assert.equal(app.apiCalls.slice(reconnectStart).filter(call => topicSend.safeParse(call).success).length, 0);
        const retiredControl = z.object({
          method: z.enum(['editMessageReplyMarkup', 'deleteMessage']),
          payload: z.object({ message_id: z.literal(panel.messageId) }),
        });
        assert.equal(app.apiCalls.slice(reconnectStart).filter(call => retiredControl.safeParse(call).success).length, 0);
      };
      await reconnect(select.request.reqId);
      await reconnect(select.request.reqId);
      if (task === tasks.question) {
        await replyText(app, panel.messageId, session.threadId, '/unknown Never treat this as an answer');
        assert.equal(app.omp.provider.requests.get(task.name)!.length, 1);
        await submitCallback(app, panel, panel.buttons[1]!);
        await completeWriteTask(app, task, instruction, session.threadId);
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === select.request.reqId && frame.value === 'Remote'));
      } else {
        const editorStart = app.apiCalls.length;
        await submitCallback(app, panel, panel.buttons[2]!);
        const editorMessageId = await waitForEditor(app, editorStart, session.threadId);
        assert.equal(editorMessageId, panel.messageId);
        const editor = app.hostFrames.findLast(frame => frame.t === 'ui-request');
        assert.ok(editor?.t === 'ui-request' && editor.request.kind === 'editor');
        originalDeliveries.splice(0, originalDeliveries.length,
          ...deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId));
        await reconnect(editor.request.reqId);
        await reconnect(editor.request.reqId);
        await replyText(app, editorMessageId, session.threadId, '/unknown Never treat this command as an answer');
        const answer = 'Custom destination\n  Preserve <literal> **content** and whitespace';
        const submitted = await replyText(app, editorMessageId, session.threadId, answer);
        const deletedControl = z.object({
          method:z.literal('deleteMessage'),
          payload:z.object({message_id:z.literal(editorMessageId)}),
          result:z.object({ok:z.literal(true)}),
        });
        await app.waitForCondition(() => app.apiCalls.slice(editorStart).some(call => deletedControl.safeParse(call).success));
        const deletedAnswer = z.object({method:z.literal('deleteMessage'),payload:z.object({message_id:z.literal(submitted.id)})});
        assert.ok(!app.apiCalls.slice(editorStart).some(call => deletedAnswer.safeParse(call).success));
        await completeWriteTask(app, task, instruction, session.threadId);
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === editor.request.reqId && frame.value === answer));
      }
      const responses = app.guestFrames.filter(frame => frame.t === 'ui-response' && frame.reqId === select.request.reqId);
      assert.equal(responses.length, 1);
      await app.waitForCondition(() => app.hostFrames.slice(questionFrames).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
      assert.equal(app.hostFrames.slice(questionFrames).filter(frame => frame.t === 'event' && frame.event.type === 'agent_end').length, 1);
    }
    const handoffStart = app.apiCalls.length;
    await app.sendAndWait(`/p ${cancelledQuestion.prompt}`, session.threadId);
    const waitingQuestion = await waitForPanel(app, 'question', 'ask:', handoffStart, session.threadId);
    const handoffEditorStart = app.apiCalls.length;
    await clickPanel(app, waitingQuestion, 2);
    const handoffEditor = await waitForEditor(app, handoffEditorStart, session.threadId);
    const handoffText = `/p ${tasks.askHandoff.prompt}`;
    const handoff = await replyText(app, handoffEditor, session.threadId, handoffText);
    await completeWriteTask(app, tasks.askHandoff, handoff, session.threadId);
    assert.ok(!app.guestFrames.some(frame => frame.t === 'ui-response' && frame.value === handoffText));
  
    const questionSettings = await openPanel(app, '/settings', session.threadId);
    await clickPanel(app, questionSettings, 0);
    await app.waitForCondition(() => savedChat().all_messages_are_prompts === false);
    for (const control of questionControls) {
      const start = app.apiCalls.length;
      const frameStart = app.hostFrames.length;
      const instruction = await app.sendAndWait(`/p ${control.prompt}`, session.threadId);
      const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
      const request = app.hostFrames.slice(frameStart).findLast(frame => frame.t === 'ui-request');
      assert.ok(request?.t === 'ui-request');
      if (control.name === 'chat-question') {
        await clickPanel(app, panel, 2);
        await app.waitForCondition(() => app.hostFrames.slice(frameStart).some(frame => frame.t === 'ui-request-end' && frame.reqId === request.request.reqId));
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === request.request.reqId && frame.value === 'Chat about this'));
        await app.waitForReply({ replyToMessageId: instruction.id, threadId: session.threadId });
        const discussion = await replyText(app, panel.messageId, session.threadId, tasks.chatHandoff.prompt);
        await completeWriteTask(app, tasks.chatHandoff, discussion, session.threadId);
      } else {
        const editorStart = app.apiCalls.length;
        await clickPanel(app, panel, 2);
        const editorMessage = await waitForEditor(app, editorStart, session.threadId);
        const editor = app.hostFrames.findLast(frame => frame.t === 'ui-request');
        assert.ok(editor?.t === 'ui-request' && editor.request.kind === 'editor');
        const cancellation = await waitForPanel(app, 'question', 'ask:', editorStart, session.threadId);
        const dismissStart = app.apiCalls.length;
        await clickPanel(app, cancellation, 0);
        await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'ui-request-end' && frame.reqId === editor.request.reqId));
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === editor.request.reqId && frame.value === undefined));
        const parent = await waitForPanel(app, 'question', 'ask:', dismissStart, session.threadId);
        const parentRequest = app.hostFrames.findLast(frame => frame.t === 'ui-request');
        assert.ok(parentRequest?.t === 'ui-request' && parentRequest.request.kind === 'select');
        await clickPanel(app, parent, -1);
        await app.waitForCondition(() => app.hostFrames.slice(frameStart).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
        assert.ok(app.guestFrames.some(frame => frame.t === 'ui-response' && frame.reqId === parentRequest.request.reqId && frame.value === undefined));
        const lateAnswer = 'Do not submit this cancelled editor reply';
        await replyText(app, editorMessage, session.threadId, lateAnswer);
        assert.ok(!app.guestFrames.some(frame => frame.t === 'prompt' && frame.text === lateAnswer));
      }
    }
    await clickPanel(app, questionSettings, 0);
    await app.waitForCondition(() => savedChat().all_messages_are_prompts === true);
    await clickPanel(app, questionSettings, -1);
    app.omp.provider.assertComplete([tasks.question.name, tasks.customAnswer.name, tasks.askHandoff.name, tasks.chatHandoff.name, interrupted.name, cancelledQuestion.name, ...questionControls.map(control => control.name)]);
  });
}
