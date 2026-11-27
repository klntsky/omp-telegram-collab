import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readConfig } from '../../../src/config.js';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { chooseSettingsAction, clickPanel, openPanel, replyText, setDefaultWorktrees, waitForPanel } from '../helpers/telegram-actions.js';

export function registerFolderSettings(getApp: () => CollaborationTest): void {
  // Permanent: Persisted per-directory policy must survive restart and drive real topic
  // enrollment; default-only worktree coverage cannot catch ignored or overwritten overrides.
  it('worktree settings persist independent directory choices and apply them to new topics', async () => {
    const app = getApp();
    const folder = 'worktree-policy-selected';
    await mkdir(join(app.omp.workspace, folder), { recursive: true });
    await writeFile(join(app.omp.workspace, folder, 'policy-marker.txt'), 'Worktree policy fixture\n');
    await app.omp.git(app.omp.workspace, 'add', '--all');
    await app.omp.git(app.omp.workspace, 'commit', '-m', 'Preserve worktree policy fixture');
    app.setFolderOptions(['.', `./${folder}/`]);
    const panel = await openPanel(app, '/settings');
    await setDefaultWorktrees(app, panel, true);
    await chooseSettingsAction(app, panel, { kind: 'worktrees', folder: '.', value: false });
    await chooseSettingsAction(app, panel, { kind: 'worktrees', folder, value: true });
    await setDefaultWorktrees(app, panel, false);
    const saved = readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
    assert.equal(saved.create_topic_worktrees, false);
    assert.deepEqual(saved.folder_worktree_overrides, { '.': false, [folder]: true });
    await chooseSettingsAction(app, panel, { kind: 'close' }, false);
    await app.restart();
    for (const [index, enabled] of [false, true].entries()) {
      const start = app.apiCalls.length;
      const topic = await app.telegram.user.client.createForumTopic({
        chatId: app.telegram.forum.chat, title: `Directory worktree policy ${index}`,
      });
      await app.waitForMessageHandled(topic.id);
      const folders = await waitForPanel(app, 'folder', 'folder:', start, topic.id);
      await clickPanel(app, folders, index);
      await app.waitForCondition(() => {
        const session = app.store.listSessions(app.telegram.bot.id).find(session => session.threadId === topic.id);
        return session !== undefined && !app.store.promptQueue.has(session.id) &&
          (!enabled || session.cwd !== join(app.omp.workspace, folder));
      });
      const session = app.store.listSessions(app.telegram.bot.id).find(session => session.threadId === topic.id)!;
      if (enabled) await app.omp.assertWorktree(session);
      else assert.equal(session.cwd, app.omp.workspace);
      assert.equal(app.store.promptQueue.has(session.id), false);
      assert.equal(await app.runtime.isRunning(session), false);
    }
    assert.deepEqual(readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!.folder_worktree_overrides,
      { '.': false, [folder]: true });
  });

  // Permanent: Folder approval must bind a manually created, existing topic without starting
  // work or creating another topic; /new coverage does not exercise this enrollment boundary.
  it('manual topics choose their runtime folder in the same topic', async () => {
    const app = getApp();
    const folder = 'manual-selected & <code> "😀`';
    app.setFolderOptions(['.', folder]);
    const start = app.apiCalls.length;
    const topic = await app.telegram.user.client.createForumTopic({
      chatId: app.telegram.forum.chat, title: 'Manual folder selection',
    });
    await app.waitForMessageHandled(topic.id);
    const sessions = () => app.store.listSessions(app.telegram.bot.id);
    assert.equal(sessions().some(session => session.threadId === topic.id), false);
    const panel = await waitForPanel(app, 'folder', 'folder:', start, topic.id);
    const selectionStart = app.apiCalls.length;
    await clickPanel(app, panel, 1);
    const creation = await waitForPanel(app, 'folder', 'folder:', selectionStart, topic.id);
    assert.equal(sessions().some(session => session.threadId === topic.id), false);
    await clickPanel(app, creation, 0);
    await app.waitForCondition(() => sessions().some(session => session.threadId === topic.id));
    const session = sessions().find(session => session.threadId === topic.id)!;
    assert.equal(session.cwd, realpathSync(join(app.omp.workspace, folder)));
    assert.equal(session.runtime.kind, 'managed');
    assert.equal(app.store.promptQueue.has(session.id), false);
    assert.equal(await app.runtime.isRunning(session), false);
    assert.equal(app.apiCalls.slice(start).some(call => call.method === 'createForumTopic'), false);
  });

  // Permanent: Retired native settings replies must stay inert even after panel history reloads
  // on restart; normal settings edits cannot detect stale replies changing folders or spawning tasks.
  it('folder entry requests native replies and saves paths without reviving retired input', async () => {
    const app = getApp();
    const panel = await openPanel(app, '/settings');
    const sessions = app.store.listSessions(app.telegram.bot.id).map(session => session.id);
    const frameStart = app.guestFrames.length;
    const entries: number[] = [];
    const savedFolders = () => readConfig(app.config.configPath).instances
      .find(instance => instance.id === 1)!.chats[0]!.folder_options ?? [];
    const choose = async (wanted: Record<string, string>) => {
      await chooseSettingsAction(app, panel, wanted, wanted.kind !== 'folders');
    };
    const enter = async (input: string) => {
      const oldMessageId = panel.messageId;
      const start = app.apiCalls.length;
      await choose({ kind: 'folders', input });
      Object.assign(panel, await waitForPanel(app, '/settings', 'settings:', start));
      assert.notEqual(panel.messageId, oldMessageId);
      const [prompt, old] = await app.telegram.user.client.getMessages(app.telegram.forum.chat, [panel.messageId, oldMessageId]);
      assert.equal(prompt?.raw._, 'message');
      if (prompt?.raw._ !== 'message') throw new Error('Missing Telegram folder prompt');
      assert.equal(prompt.raw.replyMarkup?._, 'replyInlineMarkup');
      if (prompt.raw.replyMarkup?._ !== 'replyInlineMarkup') throw new Error('Missing Telegram folder keyboard');
      assert.equal(prompt.raw.replyMarkup.forceReply, true);
      assert.ok(old?.raw._ === 'message' && !old.raw.replyMarkup);
    };
    const ignoreRetired = async () => {
      const before = savedFolders();
      for (const messageId of entries) await replyText(app, messageId, 1, 'ignored-retired-folder');
      assert.deepEqual(savedFolders(), before);
      assert.deepEqual(app.store.listSessions(app.telegram.bot.id).map(session => session.id), sessions);
      assert.deepEqual(app.guestFrames.slice(frameStart).filter(frame => frame.t === 'prompt'), []);
    };
    await choose({ kind: 'page', page: 'folders' });
    for (const input of ['append', 'replace']) {
      await enter(input);
      if (input === 'replace') await app.restart();
      // A prior entry must not write into this newer active input or become a task,
      // including after the service reloads its panel history from SQLite.
      await ignoreRetired();
      const start = app.apiCalls.length;
      await replyText(app, panel.messageId, 1, input === 'append' ? 'first & <code>\nsecond' : 'replacement');
      assert.deepEqual(savedFolders(), input === 'append' ? ['first & <code>', 'second'] : ['replacement']);
      entries.push(panel.messageId);
      Object.assign(panel, await waitForPanel(app, '/settings', 'settings:', start));
    }
    await enter('append');
    await choose({ kind: 'page', page: 'folders' });
    entries.push(panel.messageId);
    await ignoreRetired();
    assert.deepEqual(savedFolders(), ['replacement']);
    await choose({ kind: 'close' });
    const [closed] = await app.telegram.user.client.getMessages(app.telegram.forum.chat, [panel.messageId]);
    assert.ok(closed?.raw._ === 'message' && !closed.raw.replyMarkup);
    await ignoreRetired();
    assert.deepEqual(savedFolders(), ['replacement']);
  });
}
