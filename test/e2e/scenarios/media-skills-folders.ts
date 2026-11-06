import assert from 'node:assert/strict';
import { readConfig } from '../../../src/config.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, openPanel, replyText, sendImageDocument, waitForPanel } from '../helpers/telegram-actions.js';
import { completeWriteTask, taskInput } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerMediaSkillsAndFolders(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'image' | 'explicitImage' | 'settingsReply' | 'followup' | 'general'>): void {
  it('media, skills, and folders', async () => {
    const app = getApp();
    const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
    const session = await createManagedTopic(app);
    const sessionsAfterForks = app.store.listSessions(app.telegram.bot.id).map(value => value.id);
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    for (const task of [tasks.image, tasks.explicitImage]) {
      const explicit = task === tasks.explicitImage;
      if (explicit) {
        const explicitSettings = await openPanel(app, '/settings', session.threadId);
        await clickPanel(app, explicitSettings, 0);
        await app.waitForCondition(() => savedChat().all_messages_are_prompts === false);
        await sendImageDocument(app, session.threadId, 'Ignored image discussion', imageBase64);
      }
      const caption = explicit ? `/p@${app.telegram.bot.username} ${task.prompt}` : task.prompt;
      const uploaded = await sendImageDocument(app, session.threadId, caption, imageBase64);
      await completeWriteTask(app, task, uploaded, session.threadId);
      const input = taskInput(app.omp.provider, task);
      assert.deepEqual(input.images, [`data:image/png;base64,${imageBase64}`]);
      assert.ok(!input.text.includes('/skill:e2e-review'));
    }
    const promptSettings = await openPanel(app, '/settings', session.threadId);
    await replyText(app, promptSettings.messageId, session.threadId, '/unknown Not a setting or task');
    const settingsTask = await replyText(app, promptSettings.messageId, session.threadId, `/p ${tasks.settingsReply.prompt}`);
    await completeWriteTask(app, tasks.settingsReply, settingsTask, session.threadId);
    await clickPanel(app, promptSettings, 0);
    await app.waitForCondition(() => savedChat().all_messages_are_prompts === true);
  
    await app.waitForCondition(() => app.store.getSkillCatalog(session.instanceId)?.some(skill => skill.name === 'e2e-review') ?? false);
    await app.sendAndWait('/unrecognized command', session.threadId);
    const skillKey = { botId: app.telegram.bot.id, destination: { kind: 'topic' as const, chatId: session.chatId, threadId: session.threadId }, userId: app.telegram.user.account.id };
    const skillPicker = await openPanel(app, '/skills', session.threadId);
    await clickPanel(app, skillPicker, 0);
    await clickPanel(app, skillPicker, 0);
    await app.sendAndWait('/skill_e2e_review', session.threadId);
    assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-review']);
    const generalPicker = await openPanel(app, '/skills');
    await clickPanel(app, generalPicker, 0);
    const generalSkillKey = { ...skillKey, destination: { kind: 'general' as const, chatId: session.chatId } };
    await app.waitForCondition(() => app.store.getPendingSkills(generalSkillKey).includes('e2e-review'));
    await app.sendAndWait('/skills clear');
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
    assert.deepEqual(app.store.getPendingSkills(skillKey), ['e2e-review']);
    const followup = await app.sendAndWait(tasks.followup.prompt, session.threadId);
    const followupReply = await completeWriteTask(app, tasks.followup, followup, session.threadId);
    assert.equal(followupReply.replyToMessage?.id, followup.id);
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(value => value.id), sessionsAfterForks);
    assert.deepEqual(app.store.getPendingSkills(skillKey), []);
    assert.ok(taskInput(app.omp.provider, tasks.followup).text.includes(`/skill:e2e-review\n\n${tasks.followup.prompt}`));
  
    const selectedDirectory = join(app.omp.workspace, 'selected', 'nested');
    app.setFolderOptions(['selected/nested']);
    await app.sendAndWait('/skill_e2e_review');
    const folderStart = app.apiCalls.length;
    await app.sendAndWait(tasks.general.prompt);
    const folders = await waitForPanel(app, 'folder', 'folder:', folderStart);
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), sessionsAfterForks);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), ['e2e-review']);
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    await clickPanel(app, folders, folders.buttons.findIndex(data => data.endsWith(':cancel')));
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(current => current.id), sessionsAfterForks);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), ['e2e-review']);
    app.setFolderOptions(['.', 'selected/nested']);
    const confirmationStart = app.apiCalls.length;
    const general = await app.sendAndWait(tasks.general.prompt);
    const choices = await waitForPanel(app, 'folder', 'folder:', confirmationStart);
    const creationStart = app.apiCalls.length;
    await clickPanel(app, choices, 1);
    const confirmation = await waitForPanel(app, 'folder', 'folder:', creationStart);
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    await clickPanel(app, confirmation, confirmation.buttons.findIndex(data => data.endsWith(':create')));
    const generalReply = await completeWriteTask(app, tasks.general, general);
    const allSessions = app.store.listSessions(app.telegram.bot.id);
    const created = allSessions.find(value => !sessionsAfterForks.includes(value.id))!;
    assert.deepEqual(allSessions.map(value => value.id).filter(id => id !== created.id), sessionsAfterForks);
    assert.deepEqual(created.runtime, { kind: 'managed' });
    assert.equal(created.instanceId, 1);
    assert.equal(created.cwd, selectedDirectory);
    await assert.rejects(readFile(join(app.omp.workspace, tasks.general.path), 'utf8'), { code: 'ENOENT' });
    app.setFolderOptions([]);
    assert.notEqual(created.threadId, session.threadId);
    assert.notEqual(created.threadId, 1);
    assert.equal(generalReply.replyToMessage?.threadId, created.threadId);
    assert.equal(app.store.getTopic({ botId: app.telegram.bot.id, destination: { kind: 'general', chatId: session.chatId } }), undefined);
    assert.equal(app.store.hasPendingInitialTask(created.id), false);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
    assert.ok(taskInput(app.omp.provider, tasks.general).text.includes(`/skill:e2e-review\n\n${tasks.general.prompt}`));
    app.omp.provider.assertComplete([tasks.image.name, tasks.explicitImage.name, tasks.settingsReply.name, tasks.followup.name, tasks.general.name]);
  });
}
