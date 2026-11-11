import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from '../../../src/config.js';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { waitForPanel } from '../helpers/telegram-actions.js';
import { completeWriteTask, readSessionHistory } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerCapacity(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'capacityFirst' | 'capacitySecond' | 'capacityPending'>): void {
  it('managed process capacity confirmation', async t => {
    const app = getApp();
    const limit = readConfig(app.config.configPath).omp.maxSessions;
    const prerequisites = [tasks.capacityFirst, tasks.capacitySecond];
    assert.equal(limit, prerequisites.length);
    const activeThreads: number[] = [];
    for (const task of prerequisites) {
      const existingIds = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
      await app.sendAndWait(`/new ${task.prompt}`);
      await app.omp.provider.waitForRequest(task.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
      const session = app.store.listSessions(app.telegram.bot.id).find(session => !existingIds.has(session.id));
      assert.ok(session);
      assert.equal(await app.runtime.isRunning(session), true);
      activeThreads.push(session.threadId);
    }
    assert.equal((await app.omp.listHosts()).length, limit);
    const start = app.apiCalls.length;
    const sent = await app.sendAndWait(`/new ${tasks.capacityPending.prompt}`);
    const pending = app.store.listSessions(app.telegram.bot.id).find(session => app.store.hasPendingInitialTask(session.id))!;
    assert.ok(pending, 'Capacity-blocked /new must preserve its initial task');
    const confirmation = await waitForPanel(app, 'folder', 'capacity:approve:', start, pending.threadId);
    const approve = confirmation.buttons.find(data => data.startsWith('capacity:approve:'))!;
    const cancel = confirmation.buttons.find(data => data.startsWith('capacity:cancel:'))!;
    const click = (data: string, messageId = confirmation.messageId) => app.telegram.user.client.getCallbackAnswer({
      chatId: app.telegram.forum.chat, message: messageId, data: Buffer.from(data),
    });
    const assertPending = async () => {
    const app = getApp();
      assert.equal(readConfig(app.config.configPath).omp.maxSessions, limit);
      assert.equal(app.runtime.getSessionLimit(), limit);
      assert.equal(app.store.hasPendingInitialTask(pending.id), true);
      assert.deepEqual(app.omp.provider.requests.get(tasks.capacityPending.name), []);
      await assert.rejects(stat(join(pending.cwd, tasks.capacityPending.path)), { code: 'ENOENT' });
      assert.equal((await app.omp.listHosts()).length, limit);
    };
    await assertPending();
    await click(cancel);
    await assertPending();
    await click(approve);
    await assertPending();
    const refreshStart = app.apiCalls.length;
    await app.sendAndWait(`/p ${tasks.capacityPending.prompt}`, pending.threadId);
    const fresh = await waitForPanel(app, 'folder', 'capacity:approve:', refreshStart, pending.threadId);
    const freshApprove = fresh.buttons.find(data => data.startsWith('capacity:approve:'))!;
    assert.notEqual(freshApprove, approve);
    await assertPending();
    await click(freshApprove, fresh.messageId);
    await completeWriteTask(app, tasks.capacityPending, sent, pending.threadId);
    assert.equal(readConfig(app.config.configPath).omp.maxSessions, limit * 2);
    assert.equal(app.runtime.getSessionLimit(), limit * 2);
    assert.equal(app.store.hasPendingInitialTask(pending.id), false);
    assert.equal(app.omp.provider.requests.get(tasks.capacityPending.name)!.length, 2);
    assert.ok((await readSessionHistory(app.omp.dataDir, pending.id)).includes(tasks.capacityPending.toolCallId));
    for (const [index, threadId] of activeThreads.entries()) {
      await app.sendAndWait('/stop', threadId);
      await app.omp.provider.waitForAbort(prerequisites[index]!.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
    }
    app.omp.provider.assertComplete([...prerequisites.map(task => task.name), tasks.capacityPending.name]);
  });
}
