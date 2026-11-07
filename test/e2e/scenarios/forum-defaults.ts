import assert from 'node:assert/strict';
import { readConfig } from '../../../src/config.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, openPanel } from '../helpers/telegram-actions.js';
import { completeWriteTask, taskInput } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerForumDefaults(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'defaultsFirst' | 'defaultsUnchanged' | 'defaultsSwitched' | 'defaultsManual' | 'defaultsNext'>): void {
  it('forum model presets and first-prompt skills', async () => {
    const app = getApp();
    const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
    const chooseDefault = async (field: 'default_model_preset' | 'default_new_topic_skills', value?: string, expectedSkills?: string[]) => {
      const panel = await openPanel(app, '/settings');
      const choose = async (wanted: Record<string, string | undefined>) => {
        const token = panel.buttons[0]!.split(':')[1]!;
        const row = app.store.db.prepare('SELECT panel FROM settings_panels WHERE bot_id=? AND token=?').get(app.telegram.bot.id, token) as { panel: string };
        const saved = z.object({ choices: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(row.panel));
        const index = saved.choices.findIndex(action => Object.entries(wanted).every(([key, expected]) => action[key] === expected));
        assert.ok(index >= 0, `Missing native settings action ${JSON.stringify(wanted)}`);
        assert.ok(panel.buttons[index]!.startsWith(`settings:${token}:`));
        await clickPanel(app, panel, index);
      };
      await choose({ kind: 'page', page: field === 'default_model_preset' ? 'presets' : 'skills' });
      await choose({ kind: 'default', field, value });
      if (field === 'default_new_topic_skills') assert.deepEqual(savedChat()[field] ?? [], expectedSkills);
      else assert.equal(savedChat()[field], value);
      await clickPanel(app, panel, -1);
    };
    await chooseDefault('default_model_preset', 'e2e-alternate');
    await chooseDefault('default_new_topic_skills', 'e2e-review', ['e2e-review']);
    await chooseDefault('default_new_topic_skills', 'e2e-z-followup', ['e2e-review', 'e2e-z-followup']);
    const first = await app.sendAndWait(`/new ${tasks.defaultsFirst.prompt}`);
    const firstReply = await completeWriteTask(app, tasks.defaultsFirst, first);
    const session = app.store.getTopic({ botId: app.telegram.bot.id, destination: {
      kind: 'topic', chatId: app.telegram.forum.chatId, threadId: firstReply.replyToMessage!.threadId!,
    } })!;
    assert.equal(app.omp.provider.requests.get(tasks.defaultsFirst.name)![0]!.model, 'e2e-alternate');
    assert.equal(taskInput(app.omp.provider, tasks.defaultsFirst).text.split('/skill:e2e-review').length - 1, 1);
    assert.equal(taskInput(app.omp.provider, tasks.defaultsFirst).text.split('/skill:e2e-z-followup').length - 1, 1);
    assert.deepEqual(app.store.getNewTopicSkills(session.id), []);
    await chooseDefault('default_model_preset', 'e2e-primary');
    const unchanged = await app.sendAndWait(`/p ${tasks.defaultsUnchanged.prompt}`, session.threadId);
    await completeWriteTask(app, tasks.defaultsUnchanged, unchanged, session.threadId);
    assert.equal(app.omp.provider.requests.get(tasks.defaultsUnchanged.name)![0]!.model, 'e2e-alternate');
    assert.ok(!taskInput(app.omp.provider, tasks.defaultsUnchanged).text.includes('/skill:e2e-review'));
    await chooseDefault('default_model_preset', 'e2e-alternate');
    const binding = await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8');
    await app.sendAndWait('/model_preset e2e-primary', session.threadId);
    assert.equal(savedChat().default_model_preset, 'e2e-alternate');
    const switched = await app.sendAndWait(`/p ${tasks.defaultsSwitched.prompt}`, session.threadId);
    await completeWriteTask(app, tasks.defaultsSwitched, switched, session.threadId);
    assert.equal(app.omp.provider.requests.get(tasks.defaultsSwitched.name)![0]!.model, 'e2e-model');
    assert.ok(!taskInput(app.omp.provider, tasks.defaultsSwitched).text.includes('/skill:e2e-review'));
    assert.equal(await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8'), binding);
    await app.sendAndWait('/kill', session.threadId);

    const manual = await createManagedTopic(app);
    assert.deepEqual(app.store.getNewTopicSkills(manual.id), ['e2e-review', 'e2e-z-followup']);
    await chooseDefault('default_new_topic_skills', 'e2e-review', ['e2e-z-followup']);
    assert.deepEqual(app.store.getNewTopicSkills(manual.id), ['e2e-review', 'e2e-z-followup']);
    await chooseDefault('default_new_topic_skills', undefined, []);
    assert.equal(savedChat().default_new_topic_skills, undefined);
    assert.deepEqual(app.store.getNewTopicSkills(manual.id), ['e2e-review', 'e2e-z-followup']);
    await app.sendAndWait('/skill_e2e_review', manual.threadId);
    const accepted = await app.sendAndWait(`/p ${tasks.defaultsManual.prompt}`, manual.threadId);
    await completeWriteTask(app, tasks.defaultsManual, accepted, manual.threadId);
    const manualInput = taskInput(app.omp.provider, tasks.defaultsManual).text;
    assert.equal(manualInput.split('/skill:e2e-review').length - 1, 1);
    assert.equal(manualInput.split('/skill:e2e-z-followup').length - 1, 1);
    assert.deepEqual(app.store.getNewTopicSkills(manual.id), []);
    assert.equal(app.omp.provider.requests.get(tasks.defaultsManual.name)![0]!.model, 'e2e-alternate');
    await app.sendAndWait('/kill', manual.threadId);
    const next = await app.sendAndWait(`/new ${tasks.defaultsNext.prompt}`);
    await completeWriteTask(app, tasks.defaultsNext, next);
    const nextInput = taskInput(app.omp.provider, tasks.defaultsNext).text;
    assert.ok(!nextInput.includes('/skill:e2e-z-followup'));
    assert.ok(!nextInput.includes('/skill:e2e-review'));
    assert.equal(app.omp.provider.requests.get(tasks.defaultsNext.name)![0]!.model, 'e2e-alternate');
    app.omp.provider.assertComplete([tasks.defaultsFirst.name, tasks.defaultsUnchanged.name, tasks.defaultsSwitched.name, tasks.defaultsManual.name, tasks.defaultsNext.name]);
  });
}
