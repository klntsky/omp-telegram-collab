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
    bots: [{ id: 1, token: '1:fixture', miniAppShortName: 'app' }], instances: { [repository]: { chats: [{ botId: 1, chatId: -100 }] } },
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
    instancePath: app.repository, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  await assert.rejects(app.runtime.worktree({ ...session, runtime: { kind: 'attached', instanceId: 'external', sessionId: 'external' } }), /Attached OMP sessions cannot switch worktrees/);
  await assert.rejects(app.runtime.worktree({ ...session, instancePath: app.directory }), /Instance path is not configured/);
  const attached: TopicSession = { ...session, runtime: { kind: 'attached', instanceId: 'terminal', sessionId: 'terminal-session' } };
  await assert.rejects(app.runtime.setSessionTitle(attached, 'Telegram title'), /native collab registry does not support renaming/);
  await assert.rejects(app.runtime.setSessionTitle(attached, '  '), /title cannot be empty/);
});

test('restart validation pins managed history to worktree cwd while retaining forum assignment', async t => {
  const app = await fixture(t);
  const worktree = join(app.directory, 'worktree');
  await mkdir(worktree);
  const session: TopicSession = { id: 'worktree-session', botId: 1, chatId: -100, threadId: 2,
    instancePath: app.repository, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed', cwd: worktree } };
  const directory = join(app.config.dataDir, 'sessions', session.id);
  const history = join(worktree, 'native-relocated-history.jsonl');
  await mkdir(directory, { recursive: true });
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: worktree }) + '\n');
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ version: 1, sessionId: 'history-id', sessionFile: history, cwd: worktree }));
  await app.runtime.validateSessionPaths([session]);
  const stale: TopicSession = { ...session, runtime: { kind: 'managed' } };
  await app.runtime.validateSessionPaths([stale]);
  assert.deepEqual(stale.runtime, { kind: 'managed', cwd: worktree });
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, instancePath: worktree }]), /history pinned to another instance path/);
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: app.repository }) + '\n');
  await assert.rejects(app.runtime.validateSessionPaths([session]), /Saved history .* conflicts with working directory/);
});

test('managed cwd defaults to assignment and accepts a separate selected directory before history exists', async t => {
  const app = await fixture(t);
  const selected = join(app.directory, 'selected');
  await mkdir(selected);
  const session: TopicSession = { id: 'selected-session', botId: 1, chatId: -100, threadId: 3,
    instancePath: app.repository, name: 'Selected', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  await app.runtime.validateSessionPaths([session]);
  assert.deepEqual(session.runtime, { kind: 'managed' });
  session.runtime = { kind: 'managed', cwd: selected };
  await app.runtime.validateSessionPaths([session]);
  assert.deepEqual(session.runtime, { kind: 'managed', cwd: selected });
  assert.equal(session.instancePath, app.repository);
  const directory = join(app.config.dataDir, 'sessions', session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'history.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'selected-history', cwd: selected }) + '\n');
  await app.runtime.validateSessionPaths([session]);
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, runtime: { kind: 'managed' } }]), /conflicts with working directory/);
});

test('managed cwd rejects missing paths, regular files and changed canonical identities without fallback', async t => {
  const app = await fixture(t);
  const session: TopicSession = { id: 'invalid-cwd', botId: 1, chatId: -100, threadId: 4,
    instancePath: app.repository, name: 'Invalid', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  const missing = join(app.directory, 'missing');
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, runtime: { kind: 'managed', cwd: missing } }]),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT' && error.message.includes(missing));
  const file = join(app.directory, 'file');
  await writeFile(file, '');
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, runtime: { kind: 'managed', cwd: file } }]),
    (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR' && error.message.includes(file));
  const alias = join(app.directory, 'alias');
  await symlink(app.repository, alias);
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, runtime: { kind: 'managed', cwd: alias } }]), /working directory identity changed/);
});

test('managed cwd retains the OS permission diagnostic for inaccessible directories', { skip: process.getuid?.() === 0 }, async t => {
  const app = await fixture(t);
  const selected = join(app.directory, 'inaccessible');
  await mkdir(selected);
  const session: TopicSession = { id: 'inaccessible-cwd', botId: 1, chatId: -100, threadId: 5,
    instancePath: app.repository, name: 'Inaccessible', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed', cwd: selected } };
  await chmod(selected, 0);
  try {
    await assert.rejects(app.runtime.validateSessionPaths([session]),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES' && error.message.includes(selected));
  } finally { await chmod(selected, 0o700); }
});

