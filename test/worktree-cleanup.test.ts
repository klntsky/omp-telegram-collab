import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { assertWorktreeSessionSafety } from '../src/bot/worktree-cleanup.js';
import { writeConfig } from '../src/config.js';
import type { WorktreeCleanupGuard } from '../src/omp.js';
import { createWorktreeCleanup } from '../src/runtime/worktree-cleanup.js';
import { procIdentity } from '../src/runtime/process.js';
import type { ManagedHost } from '../src/runtime/types.js';
import { cleanupFixture } from './worktree-cleanup-fixture.js';

const execute = promisify(execFile);
const permitted: WorktreeCleanupGuard = { assertCurrent() {}, async beforeMutation() {} };

test('inspection identifies a pre-existing managed binding but excludes ordinary, attached, nested and unbound checkouts', async t => {
  const app = await cleanupFixture(t);
  const target = await app.target();
  assert.equal(target.path, app.linked);
  assert.equal(target.sessionId, 'cleanup-history');
  assert.notEqual(target.gitDir, target.commonDir);
  for (const [directory, identity] of [
    [target.path, target.identities.directory], [target.gitDir, target.identities.gitDir], [target.commonDir, target.identities.commonDir],
  ] as const) {
    const current = await stat(directory);
    assert.deepEqual(identity, { dev: current.dev, ino: current.ino });
  }
  assert.equal(await app.runtime.inspectWorktree({ ...app.session, runtime: { kind: 'attached', instanceId: 'terminal', sessionId: 'terminal-history' } }), undefined);
  const main = await app.bind(app.repository);
  assert.equal(await app.runtime.inspectWorktree(main), undefined);
  const nestedPath = join(app.linked, 'nested');
  await mkdir(nestedPath);
  const nested = await app.bind(nestedPath);
  assert.equal(await app.runtime.inspectWorktree(nested), undefined);
  await app.bind(app.linked);
  await unlink(app.binding);
  assert.equal(await app.runtime.inspectWorktree(app.session), undefined);
  await app.assertRetained();
});

for (const replacement of ['symlink', 'directory'] as const) {
  test(`deletion refuses ${replacement} path replacement without touching displaced or unrelated directories`, async t => {
    const app = await cleanupFixture(t);
    const target = await app.target();
    const displaced = join(app.directory, 'displaced');
    const unrelated = join(app.directory, 'unrelated');
    await mkdir(unrelated);
    const sentinel = join(unrelated, 'sentinel');
    await writeFile(sentinel, 'retain unrelated\n');
    await rename(app.linked, displaced);
    if (replacement === 'symlink') await symlink(unrelated, app.linked);
    else await mkdir(app.linked);
    await assert.rejects(app.runtime.deleteWorktree(app.session, target, permitted));
    assert.equal((await lstat(app.linked)).isSymbolicLink(), replacement === 'symlink');
    assert.equal(await readFile(join(displaced, 'tracked.txt'), 'utf8'), 'original\n');
    assert.equal(await readFile(sentinel, 'utf8'), 'retain unrelated\n');
    assert.ok((await app.git(app.repository, 'worktree', 'list', '--porcelain')).split('\n').includes(`worktree ${app.linked}`));
  });
}

for (const metadata of ['gitDir', 'commonDir'] as const) {
  test(`deletion rejects changed ${metadata} identity before Git mutation`, async t => {
    const app = await cleanupFixture(t);
    const target = await app.target();
    const displaced = join(app.directory, `displaced-${metadata}`);
    await rename(target[metadata], displaced);
    await cp(displaced, target[metadata], { recursive: true });
    await assert.rejects(app.runtime.deleteWorktree(app.session, target, permitted), /identity changed/);
    await app.assertRetained();
  });
}

test('deletion cannot substitute a sibling worktree for the bound exact path', async t => {
  const app = await cleanupFixture(t);
  const target = await app.target();
  const sibling = join(app.directory, 'sibling');
  await app.git(app.repository, 'worktree', 'add', '-b', 'sibling', sibling);
  await assert.rejects(app.runtime.deleteWorktree(app.session, { ...target, path: sibling }, permitted), /identity changed/);
  await assert.rejects(app.runtime.deleteWorktree(app.session, { ...target, path: app.repository }, permitted), /identity changed/);
  assert.equal(await readFile(join(sibling, 'tracked.txt'), 'utf8'), 'original\n');
  await app.assertRetained();
});

for (const refusal of ['dirty', 'locked'] as const) {
  test(`Git ${refusal} refusal preserves its original diagnostic and every directory`, async t => {
    const app = await cleanupFixture(t);
    const target = await app.target();
    if (refusal === 'dirty') await writeFile(join(app.linked, 'tracked.txt'), 'uncommitted evidence\n');
    else await app.git(app.repository, 'worktree', 'lock', app.linked);
    let original: (Error & { stderr: string; code: number; signal?: string | null }) | undefined;
    try {
      await execute('git', ['worktree', 'remove', '--', target.path], {
        cwd: target.commonDir, timeout: 10000, env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch (error) {
      original = error as typeof original;
    }
    assert.ok(original?.stderr, 'real Git must reject the fixture before testing diagnostic preservation');
    await assert.rejects(app.runtime.deleteWorktree(app.session, target, permitted), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(original!.stderr.trimEnd()));
      assert.equal(Reflect.get(error, 'code'), original!.code);
      assert.equal(Reflect.get(error, 'signal'), original!.signal);
      return true;
    });
    if (refusal === 'dirty') assert.equal(await readFile(join(app.linked, 'tracked.txt'), 'utf8'), 'uncommitted evidence\n');
    else assert.ok((await app.git(app.repository, 'worktree', 'list', '--porcelain')).split('\n').includes('locked'));
    await app.assertRetained();
  });
}

test('inspection refuses history stored inside the worktree instead of deleting the conversation', async t => {
  const app = await cleanupFixture(t);
  const inside = join(app.linked, 'history.jsonl');
  const session = await app.bind(app.linked, inside);
  await assert.rejects(app.runtime.inspectWorktree(session), /protected path/);
  assert.equal(JSON.parse(await readFile(inside, 'utf8')).id, 'cleanup-history');
  await app.assertRetained();
});

for (const protectedPath of ['default', 'folder', 'relative-folder', 'data', 'config', 'alias'] as const) {
  test(`cleanup refuses a configured ${protectedPath} root within the target`, async t => {
    const app = await cleanupFixture(t);
    const target = await app.target();
    if (protectedPath === 'default') app.config.instances[0]!.defaultDir = app.linked;
    if (protectedPath === 'folder') app.config.instances[0]!.chats[0]!.folder_options = ['../linked/future/project'];
    if (protectedPath === 'relative-folder') app.config.instances[0]!.chats[0]!.folder_options = ['../linked'];
    if (protectedPath === 'data') app.config.dataDir = join(app.linked, 'future-data');
    if (protectedPath === 'config') app.config.configPath = join(app.linked, 'future-config.yaml');
    if (protectedPath === 'alias') {
      const alias = join(app.directory, 'alias');
      await symlink(app.linked, alias);
      app.config.instances[0]!.chats[0]!.folder_options = ['../alias/future-project'];
    }
    await assert.rejects(assertWorktreeSessionSafety(app.config, app.store, app.session, target), /protected configured path/);
    writeConfig(app.config);
    if (protectedPath === 'data') {
      const sessionDir = join(app.config.dataDir, 'sessions', app.session.id);
      await mkdir(sessionDir, { recursive: true });
      await cp(app.binding, join(sessionDir, 'binding.json'));
    }
    await assert.rejects(app.runtime.inspectWorktree(app.session), /protected path/);
    await app.assertRetained();
  });
}

for (const status of ['open', 'closed', 'detached'] as const) {
  for (const overlap of ['same', 'nested', 'ancestor', 'alias'] as const) {
    test(`session policy protects ${status} ${overlap} cwd overlap across bots and assignments`, async t => {
      const app = await cleanupFixture(t);
      const target = await app.target();
      let cwd = overlap === 'ancestor' ? app.directory : overlap === 'nested' ? join(app.linked, 'future-subdirectory') : app.linked;
      if (overlap === 'alias') {
        cwd = join(app.directory, 'alias');
        await symlink(app.linked, cwd);
      }
      const other = app.store.createSession({ botId: 2, chatId: -200, threadId: 3, instanceId: 2, cwd }, 'Other', { kind: 'managed' });
      app.store.updateSession(other.id, { status });
      await assert.rejects(assertWorktreeSessionSafety(app.config, app.store, app.session, target), /Another session uses this worktree/);
      await app.assertRetained();
    });
  }
}

for (const overlap of ['same', 'nested', 'ancestor'] as const) {
  test(`deletion refuses a live registry host with ${overlap} cwd overlap`, async t => {
    const app = await cleanupFixture(t);
    const target = await app.target();
    const nested = join(app.linked, 'nested');
    if (overlap === 'nested') await mkdir(nested);
    await app.hosts([overlap === 'same' ? app.linked : overlap === 'nested' ? nested : app.directory]);
    await assert.rejects(app.runtime.deleteWorktree(app.session, target, permitted), /OMP host still uses this worktree/);
    await app.assertRetained();
  });
}

test('runtime preserves authorization refusal identity without removing the worktree', async t => {
  const app = await cleanupFixture(t);
  const target = await app.target();
  const denied = new Error('Current administrator access was revoked');
  await assert.rejects(app.runtime.deleteWorktree(app.session, target, {
    assertCurrent() {}, async beforeMutation() { throw denied; },
  }), error => error === denied);
  await app.assertRetained();
});

test('runtime rechecks persisted lifecycle after awaited mutation authorization', async t => {
  const app = await cleanupFixture(t);
  const target = await app.target();
  const generation = app.store.getSessionGeneration(app.session.id);
  const stale = new Error('Session generation changed during authorization');
  await assert.rejects(app.runtime.deleteWorktree(app.session, target, {
    assertCurrent() {
      if (app.store.getSession(app.session.id)?.status !== 'closed' || app.store.getSessionGeneration(app.session.id) !== generation) throw stale;
    },
    async beforeMutation() {
      await Promise.resolve();
      app.store.updateSession(app.session.id, { status: 'open' });
      app.store.advanceSessionGeneration(app.session.id);
    },
  }), error => error === stale);
  await app.assertRetained();
});

test('runtime shutdown fences deletion while a guard is awaiting authorization', async t => {
  const app = await cleanupFixture(t);
  const target = await app.target();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deletion = app.runtime.deleteWorktree(app.session, target, {
    assertCurrent() {}, async beforeMutation() { entered.resolve(); await release.promise; },
  });
  const rejected = assert.rejects(deletion, /runtime is stopping/);
  await entered.promise;
  const closing = app.runtime.close();
  release.resolve();
  await rejected;
  await closing;
  await app.assertRetained();
});

test('terminated service refuses cleanup before any Git removal', async t => {
  const app = await cleanupFixture(t);
  const target = await app.target();
  app.config.terminated = true;
  writeConfig(app.config);
  await assert.rejects(app.runtime.deleteWorktree(app.session, target, permitted));
  await app.assertRetained();
});

test('unmarked missing working directories retain the original ENOENT rather than becoming removed-worktree state', async t => {
  const app = await cleanupFixture(t);
  const displaced = join(app.directory, 'displaced');
  await rename(app.linked, displaced);
  await assert.rejects(app.runtime.inspectWorktree(app.session), error => {
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, 'code'), 'ENOENT');
    assert.ok(error.message.includes(app.linked));
    return true;
  });
  const binding = JSON.parse(await readFile(app.binding, 'utf8'));
  assert.equal(binding.removedWorktree, undefined);
  assert.equal(await readFile(join(displaced, 'tracked.txt'), 'utf8'), 'original\n');
});

test('inspection tolerates an unrelated missing Git worktree registration without pruning it', async t => {
  const app = await cleanupFixture(t);
  const missing = join(app.directory, 'missing-sibling');
  await app.git(app.repository, 'worktree', 'add', '-b', 'missing-sibling', missing);
  await rename(missing, join(app.directory, 'displaced-sibling'));
  assert.equal((await app.target()).path, app.linked);
  assert.ok((await app.git(app.repository, 'worktree', 'list', '--porcelain')).split('\n').includes(`worktree ${missing}`));
  await app.assertRetained();
});

for (const retained of ['retirement', 'supervisor'] as const) {
  test(`deletion refuses a live retained ${retained} process after registry disappearance`, async t => {
    const app = await cleanupFixture(t);
    const target = await app.target();
    const processIdentity = await procIdentity(process.pid);
    assert.ok(processIdentity);
    const host: ManagedHost = { sessionId: target.sessionId, exited: false, retiring: true };
    if (retained === 'retirement') {
      host.retirement = { pid: process.pid, start: processIdentity.start, socketPath: join(app.directory, 'retirement.sock') };
    }
    const cleanup = createWorktreeCleanup({
      config: app.config, closed: false, assertActive() {}, async acquire() {},
      stopping: new Map(), pending: new Map(), managed: new Map([[app.session.id, host]]),
      hostActivity: () => ({ busy: false, awaitingTurn: false, leases: 0, lastUsed: Date.now() }),
      readManagedBinding: async () => JSON.parse(await readFile(app.binding, 'utf8')),
      async list() { return []; },
      async lifecycle() {
        return retained === 'supervisor'
          ? { pid: 2147483647, supervisorPid: process.pid, sessionId: target.sessionId, socketPath: join(app.directory, 'lifecycle.sock') }
          : undefined;
      },
    });
    await assert.rejects(cleanup.deleteWorktree(app.session, target, permitted), /OMP host has not stopped/);
    await app.assertRetained();
  });
}
