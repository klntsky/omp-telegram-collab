import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readConfig } from '../../../src/config.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, openPanel, replyText, waitForPanel } from '../helpers/telegram-actions.js';

export function registerFolderSettings(getApp: () => CollaborationTest): void {
  it('folder entry requests native replies and saves paths without reviving retired input', async () => {
    const app = getApp();
    const panel = await openPanel(app, '/settings');
    const token = panel.buttons[0]!.split(':')[1]!;
    const sessions = app.store.listSessions(app.telegram.bot.id).map(session => session.id);
    const frameStart = app.guestFrames.length;
    const entries: number[] = [];
    const savedFolders = () => readConfig(app.config.configPath).instances
      .find(instance => instance.id === 1)!.chats[0]!.folder_options ?? [];
    const choose = async (wanted: Record<string, string>) => {
      const stored = app.store.db.prepare('SELECT panel FROM settings_panels WHERE bot_id=? AND token=?')
        .get(app.telegram.bot.id, token) as { panel: string };
      const state = JSON.parse(stored.panel) as { choices: Record<string, unknown>[] };
      const index = state.choices.findIndex(action => Object.entries(wanted).every(([key, value]) => action[key] === value));
      assert.ok(index >= 0);
      await clickPanel(app, panel, index, wanted.kind !== 'folders');
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
      await replyText(app, panel.messageId, 1, input === 'append' ? 'first\nsecond' : 'replacement');
      assert.deepEqual(savedFolders(), input === 'append' ? ['first', 'second'] : ['replacement']);
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
