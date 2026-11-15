import assert from 'node:assert/strict';
import { readConfig, writeConfig } from '../../../src/config.js';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic } from '../helpers/telegram-actions.js';
import { completeWriteTask } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerTermination(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'terminationSeed' | 'terminationPeer' | 'restored'>): void {
  it('termination', async () => {
    const app = getApp();
    const seed = await app.sendAndWait(`/new ${tasks.terminationSeed.prompt}`);
    const seedReply = await completeWriteTask(app, tasks.terminationSeed, seed);
    const separateSession = app.store.listSessions(app.telegram.bot.id).find(value => value.threadId === seedReply.replyToMessage?.threadId)!;
    const peer = await createManagedTopic(app);
    const peerTask = await app.sendAndWait(`/p ${tasks.terminationPeer.prompt}`, peer.threadId);
    await completeWriteTask(app, tasks.terminationPeer, peerTask, peer.threadId);
    assert.equal(await app.runtime.isRunning(separateSession), true);
    assert.equal(await app.runtime.isRunning(peer), true);
    await app.sendAndWait('/terminate');
    assert.equal(readConfig(app.config.configPath).terminated, true);
    assert.deepEqual(await app.omp.listHosts(), []);
    const sessionIds = app.store.listSessions(app.telegram.bot.id).map(current => current.id);
    await app.sendAndWait(`/new ${tasks.restored.prompt}`);
    await app.sendAndWait(`/p ${tasks.restored.prompt}`, separateSession.threadId);
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), sessionIds);
    await app.restart();
    assert.equal(readConfig(app.config.configPath).terminated, true);
    await app.sendAndWait('/status');
    assert.deepEqual(await app.omp.listHosts(), []);
    const resumedConfig = readConfig(app.config.configPath);
    delete resumedConfig.terminated;
    writeConfig(resumedConfig);
    const restored = await app.sendAndWait(`/p ${tasks.restored.prompt}`, separateSession.threadId);
    await completeWriteTask(app, tasks.restored, restored, separateSession.threadId);
    assert.ok(JSON.stringify(app.omp.provider.requests.get(tasks.restored.name)![0]!.messages).includes(tasks.terminationSeed.evidence.nonce));
    app.omp.provider.assertComplete([tasks.terminationSeed.name, tasks.terminationPeer.name, tasks.restored.name]);
  });
}
