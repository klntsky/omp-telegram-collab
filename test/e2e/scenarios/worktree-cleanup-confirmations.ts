import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { combineTelegramErrors } from '../helpers/errors.js';
import { clickPanel, setTopicClosed, submitCallback, waitForPanel, waitForPanelRetired } from '../helpers/telegram-actions.js';
import { applicationErrors, closeForConfirmation, createCleanupWorktree, requestCleanupConfirmation } from '../helpers/worktree-cleanup.js';

export function registerWorktreeCleanupConfirmations(getApp: () => CollaborationTest): void {
  it('worktree cleanup offers and confirmations survive restart and reopen while duplicate callbacks delete once', async () => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const bindingPath = join(app.omp.dataDir, 'sessions', session.id, 'binding.json');
    let start = app.apiCalls.length;
    await setTopicClosed(app, session, true);
    const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:o:', start, session.threadId);
    await app.restart();
    await app.runtime.stop(app.store.getSession(session.id)!);
    const confirmation = await requestCleanupConfirmation(app, session, offer);
    await app.restart();
    await app.runtime.stop(app.store.getSession(session.id)!);
    await setTopicClosed(app, session, false);
    await submitCallback(app, confirmation, confirmation.buttons[0]!);
    assert.ok(existsSync(target.path));
    assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).removedWorktree, undefined);
    await setTopicClosed(app, session, true);
    start = app.apiCalls.length;
    const errorsBefore = applicationErrors(app).length;
    await Promise.all([
      submitCallback(app, confirmation, confirmation.buttons[0]!),
      submitCallback(app, confirmation, confirmation.buttons[0]!),
    ]);
    await waitForPanelRetired(app, confirmation, start);
    assert.equal(existsSync(target.path), false);
    assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).removedWorktree, true);
    const registry = await app.omp.git(target.commonDir, 'worktree', 'list', '--porcelain');
    assert.ok(!registry.split('\n').includes(`worktree ${target.path}`));
    assert.deepEqual(applicationErrors(app).slice(errorsBefore), []);
  });

  it('worktree cleanup confirmation cannot delete a different registered directory at the same path', async t => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const confirmation = await closeForConfirmation(app, session);
    const displaced = `${target.path}-previous`;
    await app.omp.git(target.commonDir, 'worktree', 'move', target.path, displaced);
    let replacementCreated = false;
    t.after(async () => {
      const errors: unknown[] = [];
      if (replacementCreated) {
        try { await app.omp.git(target.commonDir, 'worktree', 'remove', target.path); } catch (error) { errors.push(error); }
      }
      try { await app.omp.git(target.commonDir, 'worktree', 'move', displaced, target.path); } catch (error) { errors.push(error); }
      if (errors.length) throw combineTelegramErrors(...errors);
    });
    await app.omp.git(target.commonDir, 'worktree', 'add', '-b', `cleanup-replacement-${session.id}`, target.path);
    replacementCreated = true;
    const sentinel = join(target.path, 'replacement-evidence');
    await writeFile(sentinel, 'retain the replacement worktree\n');
    await app.omp.git(target.path, 'add', '--', sentinel);
    await app.omp.git(target.path, 'commit', '-m', 'Record replacement directory evidence');
    const errorsBefore = applicationErrors(app).length;
    const start = app.apiCalls.length;
    await clickPanel(app, confirmation, 0);
    await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:o:', start, session.threadId);
    assert.equal(await readFile(sentinel, 'utf8'), 'retain the replacement worktree\n');
    assert.ok(existsSync(displaced));
    assert.equal(JSON.parse(await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8')).removedWorktree, undefined);
    assert.deepEqual(applicationErrors(app).slice(errorsBefore), []);
  });
}
