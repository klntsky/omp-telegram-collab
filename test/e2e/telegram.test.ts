import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { readConfig, writeConfig } from '../../src/config.js';
import type { AppConfig } from '../../shared/contracts.js';
import { setupCollaborationTest, type CollaborationTest } from './helpers/collaboration-fixture.js';
import { clickPanel, enrollForum, openPanel, replyText, waitForPanel } from './helpers/telegram-actions.js';
import assert from 'node:assert/strict';
import { cleanupSessions } from './helpers/session-cleanup.js';
import { questionStep } from './helpers/model-tasks.js';
import { createWorkflowTasks } from './scenarios/workflow-tasks.js';
import { registerForumDefaults } from './scenarios/forum-defaults.js';
import { registerCapacity } from './scenarios/capacity.js';
import { registerWorktreesAndForks } from './scenarios/worktrees-forks.js';
import { registerQuestions } from './scenarios/questions.js';
import { registerMediaSkillsAndFolders } from './scenarios/media-skills-folders.js';
import { registerLifecycle } from './scenarios/lifecycle.js';
import { registerLogicalIdentity } from './scenarios/logical-identity.js';
import { registerTermination } from './scenarios/termination.js';
import { registerForkFailures } from './scenarios/fork-failures.js';
import { registerMiniAppRecovery } from './scenarios/miniapp-recovery.js';
import { registerCompositePreparations } from './scenarios/composite-preparations.js';

// Register in this entry point only: imported scenarios must not provision concurrent forums.
registerForkFailures();

describe('Telegram workflows', { concurrency: false, timeout: 900000 }, suite => {
  const controls = createWorkflowTasks();
  const { tasks, scenarios, interrupted, cancelledQuestion, questionControls } = controls;
  let app: CollaborationTest;
  let baseline: AppConfig;
  const cleanups: Array<() => void | Promise<void>> = [];
  let previousIds: Set<string>;
  after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
  before(async () => {
    app = await setupCollaborationTest({
      signal: suite.signal,
      diagnostic: message => suite.diagnostic(message),
      after: cleanup => { cleanups.push(cleanup); },
    }, { scenarios: [
      ...scenarios,
      { ...interrupted, steps: [{ type: 'await-abort' }] },
      { ...cancelledQuestion, steps: [questionStep(cancelledQuestion.name)] },
      ...questionControls,
    ] });
    await enrollForum(app);
    baseline = structuredClone(readConfig(app.config.configPath));
  });
  beforeEach(async () => {
    writeConfig(structuredClone(baseline));
    app.setFolderOptions([]);
    await app.restart();
    await app.sendAndWait('/skills clear');
    previousIds = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
  });
  afterEach(async context => {
    await cleanupSessions(
      app.runtime,
      app.store,
      app.store.listSessions(app.telegram.bot.id).filter(session => !previousIds.has(session.id)),
      message => context.diagnostic(message),
    );
  });
  it('folder entry requests native replies and saves paths', async () => {
    const panel = await openPanel(app, '/settings');
    const token = panel.buttons[0]!.split(':')[1]!;
    const choose = async (wanted: Record<string, string>) => {
      const stored = app.store.db.prepare('SELECT panel FROM settings_panels WHERE bot_id=? AND token=?')
        .get(app.telegram.bot.id, token) as { panel: string };
      const state = JSON.parse(stored.panel) as { choices: Record<string, unknown>[] };
      const index = state.choices.findIndex(action => Object.entries(wanted).every(([key, value]) => action[key] === value));
      assert.ok(index >= 0);
      await clickPanel(app, panel, index, wanted.kind !== 'folders');
    };
    await choose({ kind: 'page', page: 'folders' });
    for (const input of ['append', 'replace']) {
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
      await replyText(app, panel.messageId, 1, input === 'append' ? 'first\nsecond' : 'replacement');
      const chat = readConfig(app.config.configPath).instances.find(instance => instance.id === 1)!.chats[0]!;
      assert.deepEqual(chat.folder_options, input === 'append' ? ['first', 'second'] : ['replacement']);
      const stored = app.store.db.prepare('SELECT panel FROM settings_panels WHERE bot_id=? AND token=?')
        .get(app.telegram.bot.id, token) as { panel: string };
      const state = JSON.parse(stored.panel) as { revision: number; choices: unknown[] };
      panel.buttons = state.choices.map((_, index) => `settings:${token}:${state.revision}:${index}`);
    }
  });
  registerForumDefaults(() => app, tasks);
  registerCompositePreparations(() => app, tasks);
  registerCapacity(() => app, tasks);
  registerWorktreesAndForks(() => app, tasks, () => previousIds);
  registerQuestions(() => app, tasks, controls);
  registerMediaSkillsAndFolders(() => app, tasks);
  registerLifecycle(() => app, tasks);
  registerLogicalIdentity(() => app, tasks);
  registerTermination(() => app, tasks);
});

// Keep independent provisioning last to respect Telegram's forum-creation flood limits.
registerMiniAppRecovery();
