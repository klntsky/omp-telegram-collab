import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

const execute = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-worktree-')));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  const config: AppConfig = {
    bots: [{ id: 1, token: '1:fixture', miniAppShortName: 'app' }], instances: { [repository]: { admins: [], chats: [{ botId: 1, chatId: -100 }] } },
    configPath: join(directory, 'config.yaml'), publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000, dataDir: join(directory, 'data'),
    omp: { executable: 'omp', args: [], maxSessions: 1, startupTimeoutMs: 10000 },
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, repository, config, runtime };
}

test('worktrees are unique detached HEAD checkouts, not copies of dirty instance files', async t => {
  const app = await fixture(t);
  await execute('git', ['init', app.repository]);
  await writeFile(join(app.repository, 'tracked'), 'committed\n');
  await execute('git', ['add', 'tracked'], { cwd: app.repository });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture'], { cwd: app.repository });
  await writeFile(join(app.repository, 'tracked'), 'dirty\n');
  await writeFile(join(app.repository, 'untracked'), 'private\n');
  const [first, second] = await Promise.all([app.runtime.createWorktree(app.repository), app.runtime.createWorktree(app.repository)]);
  assert.notEqual(first, second);
  for (const worktree of [first, second]) {
    assert.equal(worktree, await realpath(worktree));
    assert.equal(worktree.startsWith(join(app.config.dataDir, 'worktrees') + '/'), true);
    assert.equal(await readFile(join(worktree, 'tracked'), 'utf8'), 'committed\n');
    await assert.rejects(readFile(join(worktree, 'untracked')), { code: 'ENOENT' });
    assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout,
      (await execute('git', ['rev-parse', 'HEAD'], { cwd: app.repository })).stdout);
    await assert.rejects(execute('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: worktree }));
  }
  await app.runtime.close();
  assert.equal(await readFile(join(first, 'tracked'), 'utf8'), 'committed\n');
});

test('worktree creation preserves original git failures and configured instance authorization', async t => {
  const app = await fixture(t);
  await assert.rejects(app.runtime.createWorktree(app.repository), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /fatal: not a git repository/);
    assert.equal('code' in error && error.code, 128);
    return true;
  });
  await assert.rejects(app.runtime.createWorktree(app.directory), /Instance path is not configured/);
});

test('restart validation pins managed history to worktree cwd while retaining forum assignment', async t => {
  const app = await fixture(t);
  const worktree = join(app.directory, 'worktree');
  await mkdir(worktree);
  const session: TopicSession = { id: 'worktree-session', botId: 1, chatId: -100, threadId: 2,
    instancePath: app.repository, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed', worktreePath: worktree } };
  const directory = join(app.config.dataDir, 'sessions', session.id);
  const history = join(directory, 'history.jsonl');
  await mkdir(directory, { recursive: true });
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: worktree }) + '\n');
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ version: 1, sessionId: 'history-id', sessionFile: history, cwd: worktree }));
  await app.runtime.validateSessionPaths([session]);
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, runtime: { kind: 'managed' } }]), /conflicts with working directory/);
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, instancePath: worktree }]), /history pinned to another instance path/);
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: app.repository }) + '\n');
  await assert.rejects(app.runtime.validateSessionPaths([session]), /Saved history .* conflicts with working directory/);
});
