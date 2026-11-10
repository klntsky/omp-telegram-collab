import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { setTopicClosed, submitCallback, waitForPanelRetired } from '../helpers/telegram-actions.js';
import { applicationErrors, closeForConfirmation, createCleanupWorktree } from '../helpers/worktree-cleanup.js';

export function registerWorktreeCleanupConfirmations(getApp: () => CollaborationTest): void {
  it('worktree cleanup expires confirmations on restart and consumes duplicate callbacks once', async () => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const bindingPath = join(app.omp.dataDir, 'sessions', session.id, 'binding.json');
    const expired = await closeForConfirmation(app, session);
    await app.restart();
    await app.runtime.stop(app.store.getSession(session.id)!);

    // TDLib forwards caller-supplied callback data with read access, without checking
    // local keyboard contents. The real server acceptance of replay is exercised here.
    // https://github.com/tdlib/td/blob/master/td/telegram/CallbackQueriesManager.cpp (GetBotCallbackAnswerQuery::send)
    await submitCallback(app, expired, expired.buttons[0]!);
    assert.ok(existsSync(target.path));
    assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).removedWorktree, undefined);

    await setTopicClosed(app, session, false);
    const confirmation = await closeForConfirmation(app, session);
    const start = app.apiCalls.length;
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
}
