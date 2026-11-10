import assert from 'node:assert/strict';
import { readConfig } from '../../../src/config.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, openPanel, replyText, sendDocument, sendDocumentAlbum, sendPhoto, waitForPanel } from '../helpers/telegram-actions.js';
import { completeWriteTask, taskInput, taskReadResult } from '../helpers/model-tasks.js';
import { it } from 'node:test';
import type { WorkflowTasks } from './workflow-tasks.js';

export function registerMediaSkillsAndFolders(getApp: () => CollaborationTest, tasks: Pick<WorkflowTasks, 'image' | 'explicitImage' | 'document' | 'documentOverwrite' | 'documentOnly' | 'documentAlbum' | 'settingsReply' | 'followup' | 'general'>): void {
  it('media, skills, and folders', async t => {
    const app = getApp();
    const savedChat = () => readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
    const session = await createManagedTopic(app);
    const sessionsAfterForks = app.store.listSessions(app.telegram.bot.id).map(value => value.id);
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const photoBase64 = (await readFile(new URL('../../../assets/telegram-topics.jpg', import.meta.url))).toString('base64');
    const documentName = 'e2e-image-attachment.png';
    const documentPath = join(session.cwd, documentName);
    const uploadStart = app.apiCalls.length;
    for (const [task, bytes] of [
      [tasks.document, Buffer.from(imageBase64, 'base64')],
      [tasks.documentOverwrite, Buffer.concat([Buffer.from(imageBase64, 'base64'), Buffer.from('replacement')])],
    ] as const) {
      const uploaded = await sendDocument(app, documentName, bytes, {
        threadId: session.threadId, caption: task.prompt, mimeType: 'image/png',
      });
      await completeWriteTask(app, task, uploaded, session.threadId);
      assert.deepEqual(await readFile(documentPath), bytes);
      const input = taskInput(app.omp.provider, task);
      assert.ok(input.text.includes(documentName));
      assert.ok(input.text.includes(documentPath));
      assert.deepEqual(input.images, []);
    }
    const fileOnlyBytes = Buffer.from('A captionless document is a prompt.');
    const fileOnly = await sendDocument(app, tasks.documentOnly.prompt, fileOnlyBytes, { threadId: session.threadId });
    await completeWriteTask(app, tasks.documentOnly, fileOnly, session.threadId);
    const fileOnlyPath = join(session.cwd, tasks.documentOnly.prompt);
    assert.deepEqual(await readFile(fileOnlyPath), fileOnlyBytes);
    assert.ok(taskInput(app.omp.provider, tasks.documentOnly).text.includes(fileOnlyPath));
    assert.deepEqual(taskInput(app.omp.provider, tasks.documentOnly).images, []);
    assert.ok(JSON.stringify(taskReadResult(app.omp.provider, tasks.documentOnly)).includes(fileOnlyBytes.toString('utf8')));
    t.diagnostic(`Upload delivery evidence: ${JSON.stringify(app.apiCalls.slice(uploadStart).filter(call => call.method === 'sendMessage').map(call => call.result))}`);
    for (const task of [tasks.image, tasks.explicitImage]) {
      const explicit = task === tasks.explicitImage;
      if (explicit) {
        const explicitSettings = await openPanel(app, '/settings', session.threadId);
        await clickPanel(app, explicitSettings, 0);
        await app.waitForCondition(() => savedChat().all_messages_are_prompts === false);
        await sendPhoto(app, session.threadId, 'Ignored image discussion', photoBase64);
      }
      const caption = explicit ? `/p@${app.telegram.bot.username} ${task.prompt}` : task.prompt;
      const uploaded = await sendPhoto(app, session.threadId, caption, photoBase64);
      await completeWriteTask(app, task, uploaded, session.threadId);
      const input = taskInput(app.omp.provider, task);
      assert.equal(input.images.length, 1);
      assert.match(input.images[0]!, /^data:image\/[^;]+;base64,/);
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
    const initialDocumentName = 'initial-folder-document.txt';
    const initialDocumentBytes = Buffer.from('Save only after the destination folder is selected.');
    const initialDocumentPath = join(selectedDirectory, initialDocumentName);
    const general = await sendDocument(app, initialDocumentName, initialDocumentBytes, { caption: tasks.general.prompt });
    const choices = await waitForPanel(app, 'folder', 'folder:', confirmationStart);
    const creationStart = app.apiCalls.length;
    await clickPanel(app, choices, 1);
    const confirmation = await waitForPanel(app, 'folder', 'folder:', creationStart);
    await assert.rejects(stat(selectedDirectory), { code: 'ENOENT' });
    await assert.rejects(readFile(initialDocumentPath), { code: 'ENOENT' });
    await assert.rejects(readFile(join(app.omp.workspace, initialDocumentName)), { code: 'ENOENT' });
    await clickPanel(app, confirmation, confirmation.buttons.findIndex(data => data.endsWith(':create')));
    const generalReply = await completeWriteTask(app, tasks.general, general);
    const allSessions = app.store.listSessions(app.telegram.bot.id);
    const created = allSessions.find(value => !sessionsAfterForks.includes(value.id))!;
    assert.deepEqual(allSessions.map(value => value.id).filter(id => id !== created.id), sessionsAfterForks);
    assert.deepEqual(created.runtime, { kind: 'managed' });
    assert.equal(created.instanceId, 1);
    assert.equal(created.cwd, selectedDirectory);
    assert.deepEqual(await readFile(initialDocumentPath), initialDocumentBytes);
    assert.ok(taskInput(app.omp.provider, tasks.general).text.includes(initialDocumentPath));
    assert.deepEqual(taskInput(app.omp.provider, tasks.general).images, []);
    await assert.rejects(readFile(join(app.omp.workspace, tasks.general.path), 'utf8'), { code: 'ENOENT' });
    app.setFolderOptions([]);
    assert.notEqual(created.threadId, session.threadId);
    assert.notEqual(created.threadId, 1);
    assert.equal(generalReply.replyToMessage?.threadId, created.threadId);
    assert.equal(app.store.getTopic({ botId: app.telegram.bot.id, destination: { kind: 'general', chatId: session.chatId } }), undefined);
    assert.equal(app.store.hasPendingInitialTask(created.id), false);
    assert.deepEqual(app.store.getPendingSkills(generalSkillKey), []);
    assert.ok(taskInput(app.omp.provider, tasks.general).text.includes(`/skill:e2e-review\n\n${tasks.general.prompt}`));
    app.omp.provider.assertComplete([tasks.image.name, tasks.explicitImage.name, tasks.document.name, tasks.documentOverwrite.name, tasks.documentOnly.name, tasks.settingsReply.name, tasks.followup.name, tasks.general.name]);
  });
  it('document albums submit all files in one explicit prompt', async () => {
    const app = getApp();
    const session = await createManagedTopic(app);
    const settings = await openPanel(app, '/settings', session.threadId);
    await clickPanel(app, settings, 0);
    await app.waitForCondition(() => readConfig(app.config.configPath).instances[0]!.chats[0]!.all_messages_are_prompts === false);
    const files = [
      {name:'album-first.txt', bytes:Buffer.from('First album attachment')},
      {name:'album-second.txt', bytes:Buffer.from('Second album attachment')},
    ];
    const sent = await sendDocumentAlbum(app, session.threadId, `/p ${tasks.documentAlbum.prompt}`, files);
    await completeWriteTask(app, tasks.documentAlbum, sent[0]!, session.threadId);
    const input = taskInput(app.omp.provider, tasks.documentAlbum);
    for (const file of files) {
      const path = join(session.cwd, file.name);
      assert.deepEqual(await readFile(path), file.bytes);
      assert.ok(input.text.includes(path));
    }
    assert.deepEqual(input.images, []);
    const binding = await app.runtime.existingBinding(session);
    assert.ok(binding);
    const first = app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, sent[0]!.id);
    const second = app.store.getMessageAnchor(session.id, binding.sessionId, session.chatId, sent[1]!.id);
    assert.ok(first);
    assert.deepEqual(second, first);
    app.omp.provider.assertComplete([tasks.documentAlbum.name]);
  });
}
