import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { it } from 'node:test';
import type { TopicSession } from '../../../shared/contracts.js';
import type { WorktreeTarget } from '../../../src/omp.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import type { FakeLlmScenario } from '../helpers/fake-llm-provider.js';
import { createWriteTask, readSessionHistory } from '../helpers/model-tasks.js';
import { clickPanel, createManagedTopic } from '../helpers/telegram-actions.js';
import { applicationErrors, closeForConfirmation, createCleanupWorktree } from '../helpers/worktree-cleanup.js';

const busyTask = createWriteTask('cleanup-busy-host');
export const worktreeCleanupSafetyScenarios: readonly FakeLlmScenario[] = [
  { name: busyTask.name, prompt: busyTask.prompt, steps: [{ type: 'await-abort' }] },
];

async function evidence(app: CollaborationTest, session: TopicSession, target: WorktreeTarget) {
  const sentinel = join(target.path, 'cleanup-safety-sentinel');
  await writeFile(sentinel, session.id);
  await app.omp.git(target.path, 'add', '--', sentinel);
  await app.omp.git(target.path, 'commit', '-m', 'Record cleanup safety sentinel');
  const binding = join(app.omp.dataDir, 'sessions', session.id, 'binding.json');
  const bindingIdentity = async () => {
    const { sessionId, sessionFile, cwd, removedWorktree } = JSON.parse(await readFile(binding, 'utf8'));
    return { sessionId, sessionFile, cwd, removedWorktree };
  };
  const beforeBinding = await bindingIdentity();
  const history = await readSessionHistory(app.omp.dataDir, session.id);
  return async (checkHistory = true) => {
    const directory = await lstat(target.path);
    assert.equal(directory.dev, target.dev);
    assert.equal(directory.ino, target.ino);
    assert.equal(await readFile(sentinel, 'utf8'), session.id);
    assert.deepEqual(await bindingIdentity(), beforeBinding);
    if (checkHistory) assert.equal(await readSessionHistory(app.omp.dataDir, session.id), history);
    const registrations = await app.omp.git(target.commonDir, 'worktree', 'list', '--porcelain');
    assert.ok(registrations.split('\n').includes(`worktree ${target.path}`));
  };
}

export function registerWorktreeCleanupSafety(getApp: () => CollaborationTest): void {
  it('cleanup confirmation refuses paths shared with another stored session', async () => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const retained = await evidence(app, session, target);
    const peer = await createManagedTopic(app);
    const original = peer.cwd;
    const confirmation = await closeForConfirmation(app, session);
    const running = await app.runtime.isRunning(session);
    app.store.setSessionCwd(peer.id, target.path);
    try {
      // TDLib sends callback queries with Read access, including closed topic messages.
      // https://github.com/tdlib/td/blob/master/td/telegram/CallbackQueriesManager.cpp
      await clickPanel(app, confirmation, 0);
      const diagnostic = `Another session uses this worktree: ${peer.id}`;
      await app.waitForCondition(() => applicationErrors(app).some(values =>
        values.some(value => typeof value === 'object' && value !== null && 'message' in value && value.message === diagnostic)));
      await retained();
      assert.equal(app.store.getSession(peer.id)!.cwd, target.path);
      assert.equal(await app.runtime.isRunning(session), running);
    } finally {
      app.store.setSessionCwd(peer.id, original);
    }
  });

  it('runtime cleanup protects configured folders and symlinked configured parents', async () => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const retained = await evidence(app, session, target);
    const instance = app.config.instances.find(instance => instance.id === session.instanceId)!;
    const chat = instance.chats.find(chat => chat.chatId === session.chatId);
    assert.ok(chat);
    const previous = [...(chat.folder_options ?? [])];
    const alias = `${target.path}-protected-alias`;
    await symlink(target.path, alias, 'dir');
    try {
      for (const protectedPath of [target.path, join(alias, 'absent', 'child')]) {
        app.setFolderOptions([relative(instance.defaultDir, protectedPath)]);
        await assert.rejects(app.runtime.deleteWorktree({ ...session, status: 'closed' }, target, async () => {}), /protected path/);
        await retained();
      }
    } finally {
      app.setFolderOptions(previous);
      await unlink(alias);
    }
  });

  it('runtime cleanup rejects symlink and directory replacement without touching either directory', async () => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const retained = await evidence(app, session, target);
    await app.runtime.stop(session);
    const displaced = `${target.path}-original`;
    const replacementSentinel = join(target.path, 'replacement-sentinel');
    for (const kind of ['symlink', 'directory'] as const) {
      await rename(target.path, displaced);
      try {
        if (kind === 'symlink') await symlink(displaced, target.path, 'dir');
        else {
          await mkdir(target.path);
          // Preserve valid Git metadata so the inode guard, not missing metadata, rejects it.
          await writeFile(join(target.path, '.git'), await readFile(join(displaced, '.git')));
          await writeFile(replacementSentinel, 'retain replacement');
        }
        const replacement = await lstat(target.path);
        await assert.rejects(app.runtime.deleteWorktree({ ...session, status: 'closed' }, target, async () => {}), /identity changed/);
        assert.equal((await lstat(target.path)).ino, replacement.ino);
        assert.equal(await readFile(join(displaced, 'cleanup-safety-sentinel'), 'utf8'), session.id);
        if (kind === 'directory') assert.equal(await readFile(replacementSentinel, 'utf8'), 'retain replacement');
      } finally {
        if (kind === 'symlink') await unlink(target.path);
        else {
          await unlink(replacementSentinel);
          await unlink(join(target.path, '.git'));
          await rmdir(target.path);
        }
        await rename(displaced, target.path);
      }
      await retained();
    }
  });

  it('runtime cleanup preserves locked worktrees and clears its deletion fence after refusal', async () => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const retained = await evidence(app, session, target);
    await app.omp.git(target.commonDir, 'worktree', 'lock', '--reason', 'cleanup safety test', target.path);
    try {
      await assert.rejects(app.runtime.deleteWorktree({ ...session, status: 'closed' }, target, async () => {}), /locked/i);
      assert.equal(await readFile(join(target.gitDir, 'locked'), 'utf8'), 'cleanup safety test\n');
      await retained();
      assert.deepEqual(await app.runtime.inspectWorktree(session), target);
    } finally {
      await app.omp.git(target.commonDir, 'worktree', 'unlock', target.path);
    }
  });

  it('runtime cleanup refuses a busy native host before stopping it', async t => {
    const app = getApp();
    const { session, target } = await createCleanupWorktree(app);
    const retained = await evidence(app, session, target);
    const start = app.hostFrames.length;
    await app.sendAndWait(`/p ${busyTask.prompt}`, session.threadId);
    await app.omp.provider.waitForRequest(busyTask.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
    const host = (await app.omp.listHosts()).find(host => host.sessionId === target.sessionId);
    assert.ok(host);
    try {
      await assert.rejects(app.runtime.deleteWorktree({ ...session, status: 'closed' }, target, async () => {}), /host is busy/);
      await retained(false);
      assert.equal(await app.runtime.isRunning(session), true);
      assert.equal((await app.omp.listHosts()).find(candidate => candidate.sessionId === target.sessionId)?.pid, host.pid);
      assert.equal(app.hostFrames.slice(start).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'), false);
    } finally {
      await app.sendAndWait('/stop', session.threadId);
      await app.omp.provider.waitForAbort(busyTask.name, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
      await app.waitForCondition(() => app.hostFrames.slice(start).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
    }
  });
}
