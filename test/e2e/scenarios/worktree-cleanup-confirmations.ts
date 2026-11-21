import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { combineTelegramErrors } from '../helpers/errors.js';
import { clickPanel, setTopicClosed, submitCallback, waitForPanel, waitForPanelRetired } from '../helpers/telegram-actions.js';
import { applicationErrors, closeForConfirmation, createCleanupWorktree, requestCleanupConfirmation } from '../helpers/worktree-cleanup.js';
import { bounded } from '../helpers/async.js';

export function registerWorktreeCleanupConfirmations(getApp: () => CollaborationTest): void {
  // Permanent: a cached remote-tracking ref can outlive its server-side branch.
  // Deletion must recheck remote durability and dirtiness; ordinary confirmed
  // cleanup does not exercise the decision to skip a second confirmation.
  it('clean remote branch deletes from the offer while local dirty and stale remote branches require confirmation', async t => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const remote = await mkdtemp(join(tmpdir(), 'cleanup-remote-'));
    const name = `cleanup-${session.id}`;
    t.after(() => rm(remote, { recursive: true, force: true }));
    t.after(() => app.omp.git(target.commonDir, 'remote', 'remove', name));
    await app.omp.git(remote, 'init', '--bare');
    await app.omp.git(target.path, 'remote', 'add', name, remote);
    const branch = await app.omp.git(target.path, 'branch', '--show-current');
    assert.equal((await app.runtime.inspectWorktree(session))!.skipConfirmation, false);
    await app.omp.git(target.path, 'push', name, `HEAD:refs/heads/${branch.trim()}`);
    const dirty = join(target.path, 'untracked-cleanup-file');
    await writeFile(dirty, 'retain this');
    assert.equal((await app.runtime.inspectWorktree(session))!.skipConfirmation, false);
    await unlink(dirty);
    assert.equal((await app.runtime.inspectWorktree(session))!.skipConfirmation, true);
    await app.omp.git(remote, 'update-ref', '-d', `refs/heads/${branch.trim()}`);
    assert.equal((await app.runtime.inspectWorktree(session))!.skipConfirmation, false);
    await app.omp.git(target.path, 'push', name, `HEAD:refs/heads/${branch.trim()}`);
    const start = app.apiCalls.length;
    await setTopicClosed(app, session, true);
    const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:o:', start, session.threadId);
    const closed = app.store.getSession(session.id)!;
    const stale = await app.runtime.inspectWorktree(closed);
    assert.ok(stale?.skipConfirmation);
    await app.omp.git(remote, 'update-ref', '-d', `refs/heads/${branch.trim()}`);
    await assert.rejects(app.runtime.deleteWorktree(closed, stale, async () => {}),
      /Worktree is no longer clean with a branch on a remote/);
    assert.equal(existsSync(target.path), true);
    await app.omp.git(target.path, 'push', name, `HEAD:refs/heads/${branch.trim()}`);
    const removalStart = app.apiCalls.length;
    await clickPanel(app, offer, 0);
    await waitForPanelRetired(app, offer, removalStart);
    assert.equal(existsSync(target.path), false);
    const binding = JSON.parse(await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8'));
    assert.equal(binding.removedWorktree, true);
  });

  // Permanent: Telegram may enqueue Confirm with the pre-Cancel button snapshot.
  // Durable revocation must beat that stale update across restart/new approval;
  // valid-approval persistence tests do not cover revoked-token reuse.
  it('worktree cleanup queued Confirm stays revoked after Cancel and fresh confirmation across restart', { timeout: 120000 }, async t => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const confirmation = await closeForConfirmation(app, session);
    const editEntered = Promise.withResolvers<void>();
    const releaseEdit = Promise.withResolvers<void>();
    let hold = true;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (hold && method === 'editMessageText' && 'message_id' in payload &&
          payload.message_id === confirmation.messageId) {
        hold = false;
        editEntered.resolve();
        await releaseEdit.promise;
      }
      return previous(method, payload, signal);
    });
    const start = app.apiCalls.length;
    const cancel = submitCallback(app, confirmation, confirmation.buttons[1]!);
    let queuedConfirm: Promise<void> | undefined;
    const requestAbort = new TelegramAbortController();
    const abortRequest = () => requestAbort.abort();
    t.signal.addEventListener('abort', abortRequest, { once: true });
    t.after(async () => {
      releaseEdit.resolve();
      requestAbort.abort();
      t.signal.removeEventListener('abort', abortRequest);
      await queuedConfirm;
    }, { timeout: 30000 });
    try {
      await bounded(Promise.all([editEntered.promise, cancel]), t.signal);
      assert.equal(app.store.db.prepare('SELECT 1 FROM worktree_confirmations WHERE session_id=?').get(session.id), undefined);
      queuedConfirm = submitCallback(app, confirmation, confirmation.buttons[0]!);
      // The application poller is blocked in Cancel's edit. Read (but do not
      // acknowledge) the subsequent real Telegram update while the old UI is
      // still published; normal polling will deliver it again after release.
      const cancelUpdate = app.updates.findLast(update =>
        update.callback_query?.data === confirmation.buttons[1]);
      assert.ok(cancelUpdate);
      const queued = await app.bot.api.getUpdates({
        offset: cancelUpdate.update_id + 1, timeout: 30,
        allowed_updates: ['message', 'callback_query', 'my_chat_member', 'inline_query'],
      }, requestAbort.signal);
      const callback = queued.find(update =>
        update.callback_query?.data === confirmation.buttons[0])?.callback_query;
      assert.ok(callback?.message && 'reply_markup' in callback.message);
      assert.equal(callback.message.message_id, confirmation.messageId);
      assert.ok(callback.message.reply_markup?.inline_keyboard.flat().some(button =>
        'callback_data' in button && button.callback_data === confirmation.buttons[1]));
    } finally {
      releaseEdit.resolve();
    }
    if (queuedConfirm) await bounded(queuedConfirm, t.signal);
    const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:o:', start, session.threadId);
    assert.ok(existsSync(target.path));
    const fresh = await requestCleanupConfirmation(app, session, offer);
    assert.notEqual(fresh.buttons[0], confirmation.buttons[0]);
    await app.restart();
    await app.runtime.stop(app.store.getSession(session.id)!);
    const cancelledToken = confirmation.buttons[0]!.split(':').at(-1)!;
    assert.equal(app.store.worktreeConfirmations.get(session.id, confirmation.messageId, cancelledToken), undefined);
    assert.ok(existsSync(target.path));
    const removalStart = app.apiCalls.length;
    await submitCallback(app, fresh, fresh.buttons[0]!);
    await waitForPanelRetired(app, fresh, removalStart);
    assert.equal(existsSync(target.path), false);
  });

  // Permanent: valid approvals must survive restart, remain inactive while the
  // topic is reopened, and tolerate duplicate delivery without repeated deletion.
  // The queued-Cancel case instead exercises an approval that has been revoked.
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
    const errorsBefore = (await applicationErrors(app)).length;
    await Promise.all([
      submitCallback(app, confirmation, confirmation.buttons[0]!),
      submitCallback(app, confirmation, confirmation.buttons[0]!),
    ]);
    await waitForPanelRetired(app, confirmation, start);
    assert.equal(existsSync(target.path), false);
    assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).removedWorktree, true);
    const registry = await app.omp.git(target.commonDir, 'worktree', 'list', '--porcelain');
    assert.ok(!registry.split('\n').includes(`worktree ${target.path}`));
    assert.deepEqual((await applicationErrors(app)).slice(errorsBefore), []);
  });

  // Permanent: replacing a Git registration at the same pathname must invalidate
  // its old approval. This tests bot confirmation identity before deletion,
  // separately from the runtime's lower-level filesystem identity checks.
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
    const errorsBefore = (await applicationErrors(app)).length;
    const start = app.apiCalls.length;
    await clickPanel(app, confirmation, 0);
    await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:o:', start, session.threadId);
    assert.equal(await readFile(sentinel, 'utf8'), 'retain the replacement worktree\n');
    assert.ok(existsSync(displaced));
    assert.equal(JSON.parse(await readFile(join(app.omp.dataDir, 'sessions', session.id, 'binding.json'), 'utf8')).removedWorktree, undefined);
    assert.deepEqual((await applicationErrors(app)).slice(errorsBefore), []);
  });
}
