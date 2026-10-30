import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

const execute = promisify(execFile);

async function fixture(t: TestContext, defaultBranch = 'main') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-topic-title-')));
  let activeRuntime: OmpRuntime | undefined;
  t.after(async () => {
    await activeRuntime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repository = join(directory, 'repository');
  await mkdir(repository);
  const git = async (...args: string[]) => {
    const { stdout } = await execute('git', args, { cwd: repository, env: { ...process.env, LC_ALL: 'C' } });
    return stdout.trim();
  };
  await git('init', `--initial-branch=${defaultBranch}`);
  await git('config', 'init.defaultBranch', defaultBranch);
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial commit');
  const config: AppConfig = {
    bots: [], instances: { [repository]: { chats: [] } },
    configPath: join(directory, 'config.yaml'), publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000, dataDir: directory,
    omp: { executable: join(directory, 'omp'), args: [], maxSessions: 1, startupTimeoutMs: 10000 },
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  activeRuntime = runtime;
  const session: TopicSession = {
    id: 'title-session', botId: 1, chatId: -100, threadId: 2, instancePath: repository,
    name: 'Human title', status: 'open', createdAt: Date.now(), runtime: { kind: 'managed' },
  };
  return { directory, repository, git, config, runtime, session };
}

for (const branch of ['main', 'master', 'trunk']) {
  test(`topic title omits local default branch ${branch} and reports nondefault branches`, async t => {
    const app = await fixture(t, branch);
    if (branch !== 'trunk') await app.git('config', '--unset', 'init.defaultBranch');
    assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false });
    await app.git('switch', '-c', 'feature/readable-title');
    assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false, branch: 'feature/readable-title' });
    await app.git('checkout', '--detach');
    assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false });
  });
}

test('remote HEAD overrides local default branch without fetching', async t => {
  const app = await fixture(t);
  await app.git('branch', 'trunk');
  await app.git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  await app.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false, branch: 'main' });
  await app.git('switch', 'trunk');
  assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false });
});

test('origin HEAD takes precedence over other locally recorded remote HEADs', async t => {
  const app = await fixture(t);
  await app.git('update-ref', 'refs/remotes/another/other', 'HEAD');
  await app.git('symbolic-ref', 'refs/remotes/another/HEAD', 'refs/remotes/another/other');
  assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false, branch: 'main' });
  await app.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await app.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.deepEqual(await app.runtime.topicTitleStatus(app.session), { worktree: false });
});

test('linked worktree status comes from Git metadata and follows its current branch', async t => {
  const app = await fixture(t);
  const linked = join(app.directory, 'linked');
  await app.git('worktree', 'add', '-b', 'feature/linked', linked);
  const session: TopicSession = { ...app.session, runtime: { kind: 'managed', worktreePath: linked } };
  assert.deepEqual(await app.runtime.topicTitleStatus(session), { worktree: true, branch: 'feature/linked' });
  await app.git('switch', '-c', 'feature/primary');
  await execute('git', ['switch', 'main'], { cwd: linked });
  assert.deepEqual(await app.runtime.topicTitleStatus(session), { worktree: true });
  const subdirectory = join(linked, 'nested');
  await mkdir(subdirectory);
  assert.deepEqual(await app.runtime.topicTitleStatus({ ...session, runtime: { kind: 'managed', worktreePath: subdirectory } }), { worktree: true });
  assert.deepEqual(await app.runtime.topicTitleStatus({ ...app.session, instancePath: linked, runtime: { kind: 'managed' } }), { worktree: true });
  assert.deepEqual(await app.runtime.topicTitleStatus({ ...session, runtime: { kind: 'managed', worktreePath: app.repository } }), { worktree: false, branch: 'feature/primary' });
});

test('non-Git directories have no status even when the session records a worktree path', async t => {
  const app = await fixture(t);
  const plain = join(app.directory, 'plain');
  await mkdir(plain);
  assert.deepEqual(await app.runtime.topicTitleStatus({ ...app.session, runtime: { kind: 'managed', worktreePath: plain } }), { worktree: false });
});

test('attached sessions use the matching registry host cwd rather than instancePath', async t => {
  const app = await fixture(t);
  const linked = join(app.directory, 'linked');
  await app.git('worktree', 'add', '-b', 'feature/attached', linked);
  const host = { instanceId: 'terminal', sessionId: 'terminal-session', generation: 1, pid: process.pid,
    cwd: linked, access: 'control', relayConnected: true };
  await writeFile(app.config.omp.executable, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ version: 1, hosts: [host] }))});\n`);
  await chmod(app.config.omp.executable, 0o700);
  const session: TopicSession = { ...app.session, runtime: { kind: 'attached', instanceId: host.instanceId, sessionId: host.sessionId } };
  assert.deepEqual(await app.runtime.topicTitleStatus(session), { worktree: true, branch: 'feature/attached' });
  await assert.rejects(app.runtime.topicTitleStatus({ ...session, runtime: { kind: 'attached', instanceId: host.instanceId, sessionId: 'changed-session' } }), /Attached OMP host is not available/);
});

test('unexpected Git failures retain their subprocess diagnostics', async t => {
  const app = await fixture(t);
  await writeFile(join(app.repository, '.git', 'config'), '[invalid config\n');
  let original: Error & { code?: unknown };
  try {
    await execute('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
      cwd: app.repository, env: { ...process.env, LC_ALL: 'C' },
    });
    assert.fail('Invalid Git configuration must fail');
  } catch (error) {
    assert.ok(error instanceof Error);
    original = error;
  }
  await assert.rejects(app.runtime.topicTitleStatus(app.session), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, original.message);
    assert.ok('code' in error);
    assert.equal(error.code, original.code);
    return true;
  });
});
