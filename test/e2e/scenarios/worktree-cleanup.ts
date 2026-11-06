import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { it } from 'node:test';
import { readConfig, writeConfig } from '../../../src/config.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { changeTopicClosed, clickPanel, createManagedTopic, deliveredPanels, setTopicClosed, submitCallback, waitForPanel, waitForPanelRetired, type TelegramPanel } from '../helpers/telegram-actions.js';
import { readSessionHistory } from '../helpers/model-tasks.js';

function action(panel: TelegramPanel, name: 'offer' | 'confirm' | 'cancel'): string {
  const callback = panel.buttons.find(data => data.startsWith(`wtcleanup:${name}:`));
  assert.ok(callback, `Missing worktree cleanup ${name} protocol callback`);
  return callback;
}

export function registerWorktreeCleanup(getApp: () => CollaborationTest): void {
  it('closed-topic worktree cleanup requires fresh explicit confirmation and preserves other checkouts and history', async t => {
    const app = getApp();
    const baseline = readConfig(app.config.configPath);
    const ordinaryRepository = join(dirname(app.omp.workspace), 'cleanup-ordinary');
    await app.omp.git(dirname(app.omp.workspace), 'clone', '--no-hardlinks', app.omp.workspace, ordinaryRepository);
    const ordinaryConfig = structuredClone(baseline);
    ordinaryConfig.instances.find(instance => instance.id === 1)!.defaultDir = ordinaryRepository;
    writeConfig(ordinaryConfig);
    await app.restart();
    const ordinary = await createManagedTopic(app);
    const ordinaryStart = app.apiCalls.length;
    await setTopicClosed(app, ordinary, true);
    assert.equal(await app.runtime.inspectWorktree(app.store.getSession(ordinary.id)!), undefined);
    assert.equal(ordinary.cwd, await realpath(ordinaryRepository));
    writeConfig(baseline);
    await app.restart();

    const created = await createManagedTopic(app);
    await app.sendAndWait('/worktree e2e-cleanup-target', created.threadId);
    const session = app.store.getSession(created.id)!;
    await app.omp.assertWorktree(session, 'e2e-cleanup-target');
    const targetPath = await realpath(session.cwd);
    const bindingPath = join(app.omp.dataDir, 'sessions', session.id, 'binding.json');
    const binding = await readFile(bindingPath, 'utf8');
    const historyPath: string = JSON.parse(binding).sessionFile;
    const historyRelative = relative(targetPath, await realpath(historyPath));
    assert.ok(historyRelative === '..' || historyRelative.startsWith(`..${sep}`));
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

    const generation = app.store.getSessionGeneration(session.id);
    let start = app.apiCalls.length;
    // Manage Topics permits closed-topic delivery; callbacks require read access, not topic writes.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp#L1274-L1284
    // https://github.com/tdlib/td/blob/master/td/telegram/CallbackQueriesManager.cpp#L44-L77
    await setTopicClosed(app, session, true);
    const closedGeneration = app.store.getSessionGeneration(session.id);
    assert.ok(closedGeneration > generation);
    const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
    const [delivered] = await app.telegram.user.client.getMessages(app.telegram.forum.chat, [offer.messageId]);
    assert.ok(delivered?.raw._ === 'message' && delivered.raw.replyMarkup?._ === 'replyInlineMarkup');
    start = app.apiCalls.length;
    await clickPanel(app, offer, offer.buttons.indexOf(action(offer, 'offer')));
    const confirmation = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);
    assert.ok((await stat(targetPath)).isDirectory(), 'the first click must not remove the worktree');
    assert.equal(app.store.getSession(session.id)?.status, 'closed');
    assert.equal(app.store.getSessionGeneration(session.id), closedGeneration);
    start = app.apiCalls.length;
    await clickPanel(app, confirmation, confirmation.buttons.indexOf(action(confirmation, 'cancel')));
    await waitForPanelRetired(app, confirmation, start);
    assert.ok((await stat(targetPath)).isDirectory(), 'cancellation must preserve the worktree');

    await setTopicClosed(app, session, false);
    start = app.apiCalls.length;
    await setTopicClosed(app, session, true);
    const secondOffer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
    assert.notEqual(action(secondOffer, 'offer'), action(offer, 'offer'));
    start = app.apiCalls.length;
    await clickPanel(app, secondOffer, secondOffer.buttons.indexOf(action(secondOffer, 'offer')));
    let stale = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);
    start = app.apiCalls.length;
    await app.restart();
    await submitCallback(app, stale, action(stale, 'confirm'));
    assert.ok((await stat(targetPath)).isDirectory(), 'restart must invalidate an unused confirmation');
    const recovered = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
    start = app.apiCalls.length;
    await clickPanel(app, recovered, recovered.buttons.indexOf(action(recovered, 'offer')));
    stale = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);
    await setTopicClosed(app, session, false);
    await submitCallback(app, stale, action(stale, 'confirm'));
    assert.equal(app.store.getSession(session.id)?.status, 'open');
    assert.ok((await stat(targetPath)).isDirectory(), 'reopening must invalidate the old confirmation');

    start = app.apiCalls.length;
    await setTopicClosed(app, session, true);
    const freshOffer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
    assert.notEqual(action(freshOffer, 'offer'), action(secondOffer, 'offer'));
    assert.ok(app.store.getSessionGeneration(session.id) > closedGeneration);
    start = app.apiCalls.length;
    await clickPanel(app, freshOffer, freshOffer.buttons.indexOf(action(freshOffer, 'offer')));
    const fresh = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);
    start = app.apiCalls.length;
    await submitCallback(app, fresh, action(fresh, 'confirm'));
    await waitForPanelRetired(app, fresh, start);
    await app.waitForCondition(() => !existsSync(targetPath));
    const worktreePaths = (await app.omp.git(app.omp.workspace, 'worktree', 'list', '--porcelain'))
      .split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
    assert.ok(!worktreePaths.includes(targetPath));
    assert.ok(worktreePaths.includes(await realpath(app.omp.workspace)));
    assert.ok(worktreePaths.includes(await realpath(sibling)));
    assert.equal(await readFile(repositorySentinel, 'utf8'), 'retain repository\n');
    assert.equal(await readFile(siblingSentinel, 'utf8'), 'retain sibling\n');
    assert.equal(app.store.getSession(session.id)?.status, 'closed');
    assert.equal(app.store.getSession(session.id)?.cwd, targetPath);
    const retainedBinding = JSON.parse(await readFile(bindingPath, 'utf8'));
    for (const [key, value] of Object.entries(JSON.parse(binding))) assert.deepEqual(retainedBinding[key], value);
    assert.equal(retainedBinding.removedWorktree.path, targetPath);
    assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);
    assert.equal(await app.runtime.isRunning(app.store.getSession(session.id)!), false);
    await app.restart();
    const archived = app.store.getSession(session.id)!;
    await app.runtime.stop(archived);
    assert.equal(archived.status, 'closed');
    assert.equal(await app.runtime.isRunning(archived), false);
    assert.equal(await app.runtime.inspectWorktree(archived), undefined);
    assert.deepEqual(await app.runtime.historySource(archived), { sessionId: retainedBinding.sessionId, path: historyPath });
    assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);
    assert.equal(existsSync(targetPath), false);
    await changeTopicClosed(app, session.threadId, false);
    assert.equal(app.store.getSession(session.id)?.status, 'open');
    const sessionIds = app.store.listSessions().map(value => value.id);
    await mkdir(targetPath);
    try {
      await assert.rejects(app.runtime.ensure({ ...archived, status: 'open' }));
      await app.sendAndWait('/fork', session.threadId);
      assert.deepEqual(app.store.listSessions().map(value => value.id), sessionIds);
    } finally {
      await rmdir(targetPath);
    }
    await symlink(app.omp.workspace, targetPath);
    try {
      await app.sendAndWait('/fork', session.threadId);
      assert.deepEqual(app.store.listSessions().map(value => value.id), sessionIds);
      assert.equal(await readFile(repositorySentinel, 'utf8'), 'retain repository\n');
    } finally {
      await unlink(targetPath);
    }
    assert.equal(existsSync(targetPath), false, 'reopening must not recreate a removed worktree');
    assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);
    assert.deepEqual(deliveredPanels(app.apiCalls.slice(ordinaryStart), 'worktree-cleanup', 'wtcleanup:', ordinary.threadId), []);
    await changeTopicClosed(app, session.threadId, true);
  });
}
