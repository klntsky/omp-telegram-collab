import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { z } from 'zod';
import type { TopicSession } from '../../../shared/contracts.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, createManagedTopic, deliveredPanels, setTopicClosed, submitCallback, waitForPanel, waitForPanelRetired } from '../helpers/telegram-actions.js';
import { readSessionHistory } from '../helpers/model-tasks.js';

async function closeForConfirmation(app: CollaborationTest, session: TopicSession) {
  let start = app.apiCalls.length;
  await setTopicClosed(app, session, true);
  const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
  start = app.apiCalls.length;
  await clickPanel(app, offer, 0);
  return waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);
}

export function registerWorktreeCleanup(getApp: () => CollaborationTest): void {
  it('closed-topic worktree cleanup requires confirmation and preserves other directories and history', async t => {
    const app = getApp();
    const ordinary = await createManagedTopic(app);
    const ordinaryStart = app.apiCalls.length;
    await setTopicClosed(app, ordinary, true);
    assert.equal(await app.runtime.inspectWorktree(app.store.getSession(ordinary.id)!), undefined);

    const created = await createManagedTopic(app);
    await app.runtime.worktree(created, 'e2e-cleanup-target');
    app.store.setSessionCwd(created.id, created.cwd);
    const session = app.store.getSession(created.id)!;
    const target = await app.runtime.inspectWorktree(session);
    assert.ok(target);
    const bindingPath = join(app.omp.dataDir, 'sessions', session.id, 'binding.json');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    const history = await readSessionHistory(app.omp.dataDir, session.id);
    const repositorySentinel = join(app.omp.workspace, 'cleanup-repository-sentinel');
    const sibling = join(dirname(app.omp.workspace), 'cleanup-sibling');
    await app.omp.git(app.omp.workspace, 'worktree', 'add', '-b', 'e2e-cleanup-sibling', sibling);
    const siblingSentinel = join(sibling, 'cleanup-sibling-sentinel');
    await writeFile(repositorySentinel, 'retain repository\n');
    await writeFile(siblingSentinel, 'retain sibling\n');
    t.after(async () => {
      await unlink(siblingSentinel);
      await app.omp.git(app.omp.workspace, 'worktree', 'remove', sibling);
      await unlink(repositorySentinel);
    });

    // Manage Topics permits closed-topic delivery; callback requests require read access.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp#L1274-L1284
    // https://github.com/tdlib/td/blob/master/td/telegram/CallbackQueriesManager.cpp#L44-L77
    const cancelled = await closeForConfirmation(app, session);
    assert.ok(existsSync(target.path));
    let start = app.apiCalls.length;
    await clickPanel(app, cancelled, 1);
    await waitForPanelRetired(app, cancelled, start);
    assert.ok(existsSync(target.path));

    await setTopicClosed(app, session, false);
    const stale = await closeForConfirmation(app, session);
    await setTopicClosed(app, session, false);
    await submitCallback(app, stale, stale.buttons[0]!);
    assert.ok(existsSync(target.path));
    const dirty = await closeForConfirmation(app, session);
    const dirtyFile = join(target.path, 'uncommitted-evidence');
    await writeFile(dirtyFile, 'retain uncommitted changes\n');
    let diagnostic = '';
    await assert.rejects(app.omp.git(target.commonDir, 'worktree', 'remove', '--', target.path), error => {
      assert.ok(error instanceof Error);
      diagnostic = error.message;
      return true;
    });
    await clickPanel(app, dirty, 0);
    const loggedFailure = z.object({ event: z.literal('application.console.error'), data: z.array(z.unknown()) });
    await app.waitForCondition(() => readFileSync(join(app.omp.logDirectory, 'events.jsonl'), 'utf8').split('\n').some(line => {
      if (!line) return false;
      const event = loggedFailure.safeParse(JSON.parse(line));
      return event.success && event.data.data.some(value => z.object({ message: z.literal(diagnostic) }).safeParse(value).success);
    }));
    assert.equal(await readFile(dirtyFile, 'utf8'), 'retain uncommitted changes\n');
    await unlink(dirtyFile);
    await setTopicClosed(app, session, false);
    const confirmed = await closeForConfirmation(app, session);
    start = app.apiCalls.length;
    await clickPanel(app, confirmed, 0);
    await waitForPanelRetired(app, confirmed, start);
    assert.equal(existsSync(target.path), false);
    const worktrees = await app.omp.git(app.omp.workspace, 'worktree', 'list', '--porcelain');
    assert.ok(!worktrees.split('\n').includes(`worktree ${target.path}`));
    assert.equal(await readFile(repositorySentinel, 'utf8'), 'retain repository\n');
    assert.equal(await readFile(siblingSentinel, 'utf8'), 'retain sibling\n');
    assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).removedWorktree, true);
    assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);

    await app.restart();
    const archived = app.store.getSession(session.id)!;
    await app.runtime.stop(archived);
    assert.equal(await app.runtime.isRunning(archived), false);
    assert.deepEqual(await app.runtime.historySource(archived), { sessionId: binding.sessionId, path: binding.sessionFile });
    assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);
    await mkdir(target.path);
    try {
      await assert.rejects(app.runtime.ensure({ ...archived, status: 'open' }));
    } finally {
      await rmdir(target.path);
    }
    assert.deepEqual(deliveredPanels(app.apiCalls.slice(ordinaryStart), 'worktree-cleanup', 'wtcleanup:', ordinary.threadId), []);
  });
}
