import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { completeWriteTask, readSessionHistory } from '../helpers/model-tasks.js';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerCompositePreparations(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks,
  'compositeSeed' | 'compositeSelected' | 'compositeRecovered' | 'compositeNew'>): void {
  it('composite preparations preserve stale skills, survive later failures, and create without tasks', async t => {
    const app = getApp();

    const seed = await app.sendAndWait(`/new ${tasks.compositeSeed.prompt}`);
    const seedReply = await completeWriteTask(app, tasks.compositeSeed, seed);
    const session = app.store.getTopic({ botId: app.telegram.bot.id, destination: {
      kind: 'topic', chatId: app.telegram.forum.chatId, threadId: seedReply.replyToMessage!.threadId!,
    } })!;
    const skillKey = { botId: app.telegram.bot.id, destination: {
      kind: 'topic' as const, chatId: session.chatId, threadId: session.threadId,
    }, userId: app.telegram.user.account.id };
    app.store.addPendingSkill(skillKey, 'e2e-missing-pending');
    app.store.setNewTopicSkill(session.id, 'e2e-missing-topic');
    t.after(() => {
      app.store.clearPendingSkills(skillKey);
      app.store.clearNewTopicSkill(session.id);
    });
    const assertSkillsIntact = () => {
      assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-missing-pending']);
      assert.equal(app.store.getNewTopicSkill(session.id), 'e2e-missing-topic');
    };
    const prepare = async (command: string, threadId?: number) => {
      const frameStart = app.guestFrames.length;
      const apiStart = app.apiCalls.length;
      const requests = structuredClone([...app.omp.provider.requests]);
      const sent = await app.send(command, threadId);
      await app.waitForMessageHandled(sent.id);
      assert.deepEqual(app.guestFrames.slice(frameStart).filter(frame => frame.t === 'prompt'), []);
      assert.deepEqual([...app.omp.provider.requests], requests);
      app.omp.log('composite.preparation.deliveries', {
        messageId: sent.id, command, calls: app.apiCalls.slice(apiStart),
      });
      return sent;
    };
    const assertModel = async (sessionId: string, modelId: string) => {
      const history = (await readSessionHistory(app.omp.dataDir, sessionId)).trim().split('\n')
        .map(line => JSON.parse(line));
      const selected = history.findLast(entry => entry.type === 'model_change');
      assert.equal(selected?.model, `e2e/${modelId}`);
    };
    const run = async (task: WorkflowTasks['compositeSeed'], model: string, threadId: number) => {
      const sent = await app.sendAndWait(`/p ${task.prompt}`, threadId);
      await completeWriteTask(app, task, sent, threadId);
      assert.ok(app.omp.provider.requests.get(task.name)!.every(request => request.model === model));
    };

    await prepare('/p /model_preset e2e-alternate', session.threadId);
    assertSkillsIntact();
    await prepare('/p /model_preset openia', session.threadId);
    assertSkillsIntact();
    await assertModel(session.id, 'e2e-alternate');
    assert.equal(app.store.hasPendingInitialTask(session.id), false);
    app.store.clearPendingSkills(skillKey);
    app.store.clearNewTopicSkill(session.id);
    await run(tasks.compositeSelected, 'e2e-alternate', session.threadId);

    // A reader lease allows preset control but blocks host replacement by /worktree.
    const release = app.runtime.retain(session.id);
    try {
      await prepare('/p /model_preset e2e-primary /worktree', session.threadId);
    } finally {
      release();
    }
    await assertModel(session.id, 'e2e-model');
    assert.equal(app.store.getSession(session.id)!.cwd, session.cwd);
    assert.equal(app.store.hasPendingInitialTask(session.id), false);
    await run(tasks.compositeRecovered, 'e2e-model', session.threadId);
    await app.sendAndWait('/kill', session.threadId);

    const previousIds = new Set(app.store.listSessions(app.telegram.bot.id).map(value => value.id));
    await prepare('/new /worktree /model_preset e2e-alternate');
    const created = app.store.listSessions(app.telegram.bot.id).filter(value => !previousIds.has(value.id));
    assert.equal(created.length, 1);
    const fresh = created[0]!;
    assert.notEqual(fresh.threadId, session.threadId);
    assert.deepEqual(fresh.runtime, { kind: 'managed' });
    assert.notEqual(fresh.cwd, app.omp.workspace);
    assert.equal(await app.omp.git(fresh.cwd, 'rev-parse', '--show-toplevel'), fresh.cwd);
    assert.equal(app.store.hasPendingInitialTask(fresh.id), false);
    await assertModel(fresh.id, 'e2e-alternate');
    await run(tasks.compositeNew, 'e2e-alternate', fresh.threadId);
    app.omp.provider.assertComplete([
      tasks.compositeSeed.name, tasks.compositeSelected.name,
      tasks.compositeRecovered.name, tasks.compositeNew.name,
    ]);
  });
}
