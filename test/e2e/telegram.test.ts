import { after, afterEach, before, beforeEach, describe } from 'node:test';
import { readConfig, writeConfig } from '../../src/config.js';
import type { AppConfig } from '../../shared/contracts.js';
import { setupCollaborationTest, type CollaborationTest } from './helpers/collaboration-fixture.js';
import { enrollForum } from './helpers/telegram-actions.js';
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
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const session of app.store.listSessions(app.telegram.bot.id)) {
      if (previousIds.has(session.id)) continue;
      if (session.status === 'open' && app.store.hasPendingInitialTask(session.id)) {
        try { await app.sendAndWait('/kill', session.threadId); } catch (error) { errors.push(error); }
      }
      try { await app.runtime.kill(session); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
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
