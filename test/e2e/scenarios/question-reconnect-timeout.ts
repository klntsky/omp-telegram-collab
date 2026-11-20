import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import type { BotComponents } from '../../../src/bot/composition.js';
import type { Listener } from '../../../src/bot/types.js';
import type { Omp } from '../../../src/omp.js';
import type { CollabConnection } from '../../../shared/contracts.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { bounded } from '../helpers/async.js';
import { completeWriteTask } from '../helpers/model-tasks.js';
import { createManagedTopic, deliveredPanels, submitCallback, waitForPanel } from '../helpers/telegram-actions.js';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerQuestionReconnectTimeout(getApp: () => CollaborationTest, task: WorkflowTasks['questionReconnectTimeout']): void {
  it('question reconnect timeout', async t => {
    const app = getApp();
    const session = await createManagedTopic(app);
    const start = app.apiCalls.length;
    const questionStart = app.hostFrames.length;
    const guestStart = app.guestFrames.length;
    const instruction = await app.sendAndWait(`/p ${task.prompt}`, session.threadId);
    const panel = await waitForPanel(app, 'question', 'ask:', start, session.threadId);
    const request = app.hostFrames.slice(questionStart).findLast(frame => frame.t === 'ui-request');
    assert.ok(request?.t === 'ui-request' && request.request.kind === 'select');
    const reqId = request.request.reqId;
    const originalPanels = deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId);
    const components: BotComponents = Reflect.get(app.service, 'components');
    const runtime: Omp = app.runtime;
    const connect = runtime.connectCollab;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let first = true;
    let lateListener: Listener | undefined;
    let lateOperation: Promise<CollabConnection> | undefined;
    let failure: unknown;
    let failed = false;
    const cleanupErrors: unknown[] = [];
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(60000)]);
    runtime.connectCollab = async (...args: Parameters<Omp['connectCollab']>) => {
      if (!first) {
        await retry.promise;
        return connect.apply(runtime, args);
      }
      first = false;
      lateListener = components.connections.listeners.get(session.id);
      entered.resolve();
      const operation = (async () => {
        await release.promise;
        const connection = await connect.apply(runtime, args);
        return {
          send: connection.send.bind(connection),
          refreshSnapshot: connection.refreshSnapshot.bind(connection),
          close() {
            try { connection.close(); } finally { closed.resolve(); }
          },
        };
      })();
      lateOperation = operation;
      return operation;
    };
    const reconnectStart = app.apiCalls.length;
    try {
      assert.equal(app.omp.disconnectGuests(), 1);
      await bounded(entered.promise, signal);
      assert.ok(lateListener, 'The blocked operation must belong to a real replacement listener');
      const recovery = components.owners.metadataOwners.get(session.id)?.recovery;
      assert.ok(recovery, 'The blocked listener must belong to the active recovery operation');
      await assert.rejects(bounded(recovery, signal), error => error instanceof Error && error.name === 'TimeoutError');
      assert.notEqual(components.connections.listeners.get(session.id), lateListener,
        'The actual five-second recovery deadline must drop the blocked replacement listener');
      release.resolve();
      await bounded(closed.promise, signal);
      const replayStart = app.hostFrames.length;
      retry.resolve();
      await app.waitForCondition(() => {
        const frames = app.hostFrames.slice(replayStart);
        const replay = frames.findIndex(frame => frame.t === 'ui-request' && frame.request.reqId === reqId);
        return replay >= 0 && frames.slice(replay + 1).some(frame =>
          frame.t === 'event' && frame.event.type === 'notice' && frame.event.source === 'collab' &&
          frame.event.message === `Telegram @${app.bot.botInfo.username} joined the collab session`);
      });
      const listener = components.connections.listeners.get(session.id);
      assert.ok(listener);
      await listener.tail;
      assert.equal(components.connections.listeners.get(session.id), listener);
      assert.deepEqual(deliveredPanels(app.apiCalls.slice(start), 'question', 'ask:', session.threadId), originalPanels,
        'A timed-out replacement must retain the original Telegram question message IDs and callback tokens, not redeliver the question');
      const retirement = z.object({
        method: z.enum(['editMessageReplyMarkup', 'editMessageText', 'deleteMessage']),
        payload: z.object({ message_id: z.number() }),
      });
      const originalIds = new Set(originalPanels.map(value => value.messageId));
      assert.deepEqual(app.apiCalls.slice(reconnectStart).filter(call => {
        const parsed = retirement.safeParse(call);
        return parsed.success && originalIds.has(parsed.data.payload.message_id);
      }), [], 'A recovery deadline must not retire the original question controls');
      await submitCallback(app, panel, panel.buttons[1]!);
      await completeWriteTask(app, task, instruction, session.threadId);
      const responses = app.guestFrames.slice(guestStart).filter(frame => frame.t === 'ui-response' && frame.reqId === reqId);
      assert.equal(responses.length, 1);
      assert.ok(responses[0]?.t === 'ui-response' && responses[0].value === 'Remote');
      app.omp.provider.assertComplete([task.name]);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      release.resolve();
      retry.resolve();
      try {
        if (lateOperation) {
          const connection = await bounded(lateOperation, AbortSignal.timeout(15000));
          connection.close();
          await bounded(closed.promise, AbortSignal.timeout(15000));
        }
      } catch (error) {
        cleanupErrors.push(error);
        t.diagnostic(`Late reconnect cleanup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      runtime.connectCollab = connect;
    }
    if (failed && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors],
      [failure, ...cleanupErrors].map(error => error instanceof Error ? error.message : String(error)).join('\n'), { cause: failure });
    if (failed) throw failure;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors,
      cleanupErrors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
}
