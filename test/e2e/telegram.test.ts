import { after, afterEach, before, beforeEach, describe } from 'node:test';
import { readConfig, writeConfig } from '../../src/config.js';
import type { AppConfig } from '../../shared/contracts.js';
import { setupCollaborationTest, type CollaborationTest } from './helpers/collaboration-fixture.js';
import { enrollForum } from './helpers/telegram-actions.js';
import { cleanupSessions } from './helpers/session-cleanup.js';
import { questionStep } from './helpers/model-tasks.js';
import { createWorkflowTasks } from './scenarios/workflow-tasks.js';
import { registerForumDefaults } from './scenarios/forum-defaults.js';
import { registerCapacity } from './scenarios/capacity.js';
import { registerWorktreesAndForks } from './scenarios/worktrees-forks.js';
import { registerQuestions } from './scenarios/questions.js';
import { registerQuestionReconnectTimeout } from './scenarios/question-reconnect-timeout.js';
import { registerQuestionReconnectAnswer } from './scenarios/question-reconnect-answer.js';
import { registerMediaSkillsAndFolders } from './scenarios/media-skills-folders.js';
import { registerLifecycle } from './scenarios/lifecycle.js';
import { registerLogicalIdentity } from './scenarios/logical-identity.js';
import { registerTermination } from './scenarios/termination.js';
import { registerForkFailures } from './scenarios/fork-failures.js';
import { registerMiniAppRecovery } from './scenarios/miniapp-recovery.js';
import { registerWorktreeCleanup } from './scenarios/worktree-cleanup.js';
import { registerWorktreeCleanupConfirmations } from './scenarios/worktree-cleanup-confirmations.js';
import { registerWorktreeCleanupSafety, worktreeCleanupSafetyScenarios } from './scenarios/worktree-cleanup-safety.js';
import { registerCompositePreparations } from './scenarios/composite-preparations.js';
import { registerFolderSettings } from './scenarios/folder-settings.js';
import { registerProviderSetup } from './scenarios/provider-setup.js';
import { registerChatIsolation } from './scenarios/chat-isolation.js';
import { registerPromptQueue } from './scenarios/prompt-queue.js';

// Register in this entry point only: imported scenarios must not provision concurrent forums.
registerForkFailures();
registerChatIsolation();

// Sharing the fixture avoids reprovisioning across the worktree and question workflows.
// Their combined serial runtime exceeds 15 minutes; individual operations retain deadlines.
describe('Telegram workflows', { concurrency: false, timeout: 1200000 }, suite => {
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
      ...worktreeCleanupSafetyScenarios,
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
  registerWorktreeCleanup(() => app);
  registerWorktreeCleanupSafety(() => app);
  registerWorktreeCleanupConfirmations(() => app);
  registerFolderSettings(() => app);
  registerForumDefaults(() => app, tasks);
  registerCompositePreparations(() => app, tasks);
  registerCapacity(() => app, tasks);
  registerWorktreesAndForks(() => app, tasks, () => previousIds);
  registerQuestions(() => app, tasks, controls);
  registerQuestionReconnectTimeout(() => app, tasks.questionReconnectTimeout);
  registerQuestionReconnectAnswer(() => app, tasks.questionReconnectAnswer);
  registerMediaSkillsAndFolders(() => app, tasks);
  registerLifecycle(() => app, tasks);
  registerLogicalIdentity(() => app, tasks);
  registerTermination(() => app, tasks);
});

// Keep independent provisioning last to respect Telegram's forum-creation flood limits.
registerMiniAppRecovery();
registerProviderSetup();
registerPromptQueue();
