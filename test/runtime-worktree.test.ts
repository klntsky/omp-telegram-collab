import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-worktree-')));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  const config: AppConfig = {
    bots: [{ id: 1, token: '1:fixture', miniAppShortName: 'app' }], instances: [{id: 1, defaultDir: repository, chats: [{ botId: 1, chatId: -100 }]}],
    configPath: join(directory, 'config.yaml'), publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000, dataDir: join(directory, 'data'),
    omp: { executable: 'omp', args: [], maxSessions: 1, startupTimeoutMs: 10000 },
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, repository, config, runtime };
}

test('native worktrees reject externally owned sessions and unconfigured instances', async t => {
  const app = await fixture(t);
  const session: TopicSession = { id: 'worktree-session', botId: 1, chatId: -100, threadId: 2,
    instanceId: 1, cwd: app.repository, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  await assert.rejects(app.runtime.worktree({ ...session, runtime: { kind: 'attached', instanceId: 'external', sessionId: 'external' } }), /Attached OMP sessions cannot switch worktrees/);
  await assert.rejects(app.runtime.worktree({ ...session, instanceId: 2 }), /Instance path is not configured/);
  const attached: TopicSession = { ...session, runtime: { kind: 'attached', instanceId: 'terminal', sessionId: 'terminal-session' } };
  await assert.rejects(app.runtime.setSessionTitle(attached, 'Telegram title'), /native collab registry does not support renaming/);
  await assert.rejects(app.runtime.setSessionTitle(attached, '  '), /title cannot be empty/);
});

test('restart validation pins managed history to worktree cwd while retaining forum assignment', async t => {
  const app = await fixture(t);
  const worktree = join(app.directory, 'worktree');
  await mkdir(worktree);
  const session: TopicSession = { id: 'worktree-session', botId: 1, chatId: -100, threadId: 2,
    instanceId: 1, cwd: worktree, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  const directory = join(app.config.dataDir, 'sessions', session.id);
  const history = join(worktree, 'native-relocated-history.jsonl');
  await mkdir(directory, { recursive: true });
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: worktree }) + '\n');
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ version: 1, sessionId: 'history-id', sessionFile: history, cwd: worktree }));
  await app.runtime.validateSessionPaths([session]);
  const stale: TopicSession = { ...session, cwd: app.repository, runtime: { kind: 'managed' } };
  await app.runtime.validateSessionPaths([stale]);
  assert.equal(stale.cwd, worktree);
  assert.deepEqual(stale.runtime, { kind: 'managed' });
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, instanceId: 2 }]), /history pinned to another instance ID/);
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: app.repository }) + '\n');
  const invalid: TopicSession = { ...session, cwd: app.repository };
  await app.runtime.validateSessionPaths([invalid, stale]);
  assert.equal(invalid.cwd, app.repository, 'invalid history must not overwrite persisted cwd');
  await assert.rejects(app.runtime.resolveExisting(session), /Managed OMP history identity changed/);
});

test('managed cwd defaults to assignment and accepts a separate selected directory before history exists', async t => {
  const app = await fixture(t);
  const selected = join(app.directory, 'selected');
  await mkdir(selected);
  const session: TopicSession = { id: 'selected-session', botId: 1, chatId: -100, threadId: 3,
    instanceId: 1, cwd: app.repository, name: 'Selected', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  await app.runtime.validateSessionPaths([session]);
  assert.deepEqual(session.runtime, { kind: 'managed' });
  session.cwd = selected;
  await app.runtime.validateSessionPaths([session]);
  assert.deepEqual(session.runtime, { kind: 'managed' });
  assert.equal(session.cwd, selected);
  const directory = join(app.config.dataDir, 'sessions', session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'history.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'selected-history', cwd: selected }) + '\n');
  await app.runtime.validateSessionPaths([session]);
  await app.runtime.validateSessionPaths([{ ...session, cwd: app.repository }]);
  assert.equal(session.cwd, selected);
});

test('managed cwd rejects missing paths, regular files and changed canonical identities without fallback', async t => {
  const app = await fixture(t);
  t.mock.method(app.runtime, 'isRunning', async () => false);
  const session: TopicSession = { id: 'invalid-cwd', botId: 1, chatId: -100, threadId: 4,
    instanceId: 1, cwd: app.repository, name: 'Invalid', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  const missing = join(app.directory, 'missing');
  await assert.rejects(app.runtime.listSkills(1, { ...session, cwd: missing }),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT' && error.message.includes(missing));
  const file = join(app.directory, 'file');
  await writeFile(file, '');
  await assert.rejects(app.runtime.listSkills(1, { ...session, cwd: file }),
    (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR' && error.message.includes(file));
  const alias = join(app.directory, 'alias');
  await symlink(app.repository, alias);
  await assert.rejects(app.runtime.listSkills(1, { ...session, cwd: alias }), /working directory identity changed/);
});

test('managed cwd retains the OS permission diagnostic for inaccessible directories', { skip: process.getuid?.() === 0 }, async t => {
  const app = await fixture(t);
  t.mock.method(app.runtime, 'isRunning', async () => false);
  const selected = join(app.directory, 'inaccessible');
  await mkdir(selected);
  const session: TopicSession = { id: 'inaccessible-cwd', botId: 1, chatId: -100, threadId: 5,
    instanceId: 1, cwd: selected, name: 'Inaccessible', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  await chmod(selected, 0);
  try {
    await assert.rejects(app.runtime.listSkills(1, session),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES' && error.message.includes(selected));
  } finally { await chmod(selected, 0o700); }
});

