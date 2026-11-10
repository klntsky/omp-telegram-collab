import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readConfig } from '../../../src/config.js';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, openPanel, sendDocument, waitForPanel } from '../helpers/telegram-actions.js';
import { completeWriteTask, readSessionHistory, taskInput } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerCapacity(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'capacityFirst' | 'capacitySecond' | 'capacityPending' | 'documentPreparation'>): void {
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
    const worktrees = await openPanel(app, '/settings');
    await clickPanel(app, worktrees, 5);
    await app.waitForCondition(() => readConfig(app.config.configPath).instances[0]!.chats[0]!.create_topic_worktrees === true);
    await clickPanel(app, worktrees, -1);
    const start = app.apiCalls.length;
    const documentName = 'capacity-pending-upload.txt';
    const documentBytes = Buffer.from('Preserve this upload until managed capacity is approved.');
    const sent = await sendDocument(app, documentName, documentBytes, {
      caption: `/new ${tasks.capacityPending.prompt}`, mimeType: 'text/plain',
    });
    await app.waitForCondition(() => app.store.listSessions(app.telegram.bot.id).some(session => app.store.hasPendingInitialTask(session.id)));
    const pending = app.store.listSessions(app.telegram.bot.id).find(session => app.store.hasPendingInitialTask(session.id))!;
    assert.ok(pending, 'Capacity-blocked /new must preserve its initial task');
    const documentPath = join(pending.cwd, documentName);
    const confirmation = await waitForPanel(app, 'folder', 'capacity:approve:', start, pending.threadId);
    const pendingContent = app.store.getPendingInitialTask(pending.id);
    assert.ok(pendingContent);
    assert.ok(pendingContent.documents);
    assert.equal(pendingContent.text, tasks.capacityPending.prompt);
    assert.equal(pendingContent.documents?.length, 1);
    assert.equal(pendingContent.documents[0]!.fileName, documentName);
    assert.ok(pendingContent.documents[0]!.fileId);
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
      assert.deepEqual(app.store.getPendingInitialTask(pending.id), pendingContent);
      assert.deepEqual(app.omp.provider.requests.get(tasks.capacityPending.name), []);
      await assert.rejects(stat(join(pending.cwd, tasks.capacityPending.path)), { code: 'ENOENT' });
      await assert.rejects(stat(documentPath), { code: 'ENOENT' });
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
    await app.waitForCondition(() => {
      const current = app.store.getSession(pending.id);
      return current !== undefined && current.cwd !== pending.cwd;
    });
    await completeWriteTask(app, tasks.capacityPending, sent, pending.threadId);
    assert.equal(readConfig(app.config.configPath).omp.maxSessions, limit * 2);
    assert.equal(app.runtime.getSessionLimit(), limit * 2);
    assert.equal(app.store.hasPendingInitialTask(pending.id), false);
    const admitted = app.store.getSession(pending.id)!;
    await app.omp.assertWorktree(admitted);
    const admittedDocumentPath = join(admitted.cwd, documentName);
    assert.notEqual(admitted.cwd, pending.cwd);
    assert.deepEqual(await readFile(admittedDocumentPath), documentBytes);
    await assert.rejects(stat(documentPath), {code:'ENOENT'});
    const input = taskInput(app.omp.provider, tasks.capacityPending);
    assert.ok(input.text.includes(tasks.capacityPending.prompt));
    assert.ok(input.text.includes(documentName));
    assert.ok(input.text.includes(admittedDocumentPath));
    assert.deepEqual(input.images, []);
    assert.equal(app.omp.provider.requests.get(tasks.capacityPending.name)!.length, 2);
    assert.ok((await readSessionHistory(app.omp.dataDir, pending.id)).includes(tasks.capacityPending.toolCallId));
    for (const [index, threadId] of activeThreads.entries()) {
      await app.sendAndWait('/stop', threadId);
      await app.omp.provider.waitForAbort(prerequisites[index]!.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
    }
    app.omp.provider.assertComplete([...prerequisites.map(task => task.name), tasks.capacityPending.name]);
  });
  it('initial document preparation resumes remaining extensions after restart', async () => {
    const app = getApp();
    const nativeSettingsPath = join(dirname(app.omp.workspace), 'home', '.omp', 'agent', 'config.yml');
    const original = await readFile(nativeSettingsPath, 'utf8');
    const settings = JSON.parse(original);
    settings.modelPresets['e2e-alternate'].modelRoles.default = 'e2e/missing-model';
    await writeFile(nativeSettingsPath, JSON.stringify(settings));
    try {
      const previous = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
      const filename = 'prepared-document.txt';
      const bytes = Buffer.from('Keep the completed worktree when later preparation fails.');
      const sent = await sendDocument(app, filename, bytes, {
        caption: `/new /worktree /model_preset e2e-alternate ${tasks.documentPreparation.prompt}`,
      });
      await app.waitForCondition(() => app.store.listSessions(app.telegram.bot.id).some(session => !previous.has(session.id)));
      const pending = app.store.listSessions(app.telegram.bot.id).find(session => !previous.has(session.id))!;
      await app.waitForCondition(() => {
        const setup = app.store.getInitialDocumentSetup(pending.id);
        return setup?.extensions.length === 1 && setup.extensions[0]?.kind === 'model-preset';
      });
      await app.waitForMessageHandled(sent.id);
      const prepared = app.store.getSession(pending.id)!;
      assert.notEqual(prepared.cwd, app.omp.workspace);
      assert.equal(app.store.hasPendingInitialTask(pending.id), true);
      await assert.rejects(stat(join(prepared.cwd, filename)), {code:'ENOENT'});
      await writeFile(nativeSettingsPath, original);
      await app.restart();
      await completeWriteTask(app, tasks.documentPreparation, sent, prepared.threadId);
      assert.equal(app.store.getSession(pending.id)!.cwd, prepared.cwd);
      assert.deepEqual(await readFile(join(prepared.cwd, filename)), bytes);
      assert.equal(app.store.getInitialDocumentSetup(pending.id), undefined);
      app.omp.provider.assertComplete([tasks.documentPreparation.name]);
    } finally {
      await writeFile(nativeSettingsPath, original);
    }
  });
}
