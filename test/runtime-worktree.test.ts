import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

test('native worktrees reject externally owned sessions and unconfigured instances', async t => {
  const app = await fixture(t);
  const session: TopicSession = { id: 'worktree-session', botId: 1, chatId: -100, threadId: 2,
    instancePath: app.repository, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed' } };
  await assert.rejects(app.runtime.worktree({ ...session, runtime: { kind: 'attached', instanceId: 'external', sessionId: 'external' } }), /Attached OMP sessions cannot switch worktrees/);
  await assert.rejects(app.runtime.worktree({ ...session, instancePath: app.directory }), /Instance path is not configured/);
});

test('restart validation pins managed history to worktree cwd while retaining forum assignment', async t => {
  const app = await fixture(t);
  const worktree = join(app.directory, 'worktree');
  await mkdir(worktree);
  const session: TopicSession = { id: 'worktree-session', botId: 1, chatId: -100, threadId: 2,
    instancePath: app.repository, name: 'Worktree', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'managed', worktreePath: worktree } };
  const directory = join(app.config.dataDir, 'sessions', session.id);
  const history = join(worktree, 'native-relocated-history.jsonl');
  await mkdir(directory, { recursive: true });
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: worktree }) + '\n');
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ version: 1, sessionId: 'history-id', sessionFile: history, cwd: worktree }));
  await app.runtime.validateSessionPaths([session]);
  const stale: TopicSession = { ...session, runtime: { kind: 'managed' } };
  await app.runtime.validateSessionPaths([stale]);
  assert.deepEqual(stale.runtime, { kind: 'managed', worktreePath: worktree });
  await assert.rejects(app.runtime.validateSessionPaths([{ ...session, instancePath: worktree }]), /history pinned to another instance path/);
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: 'history-id', cwd: app.repository }) + '\n');
  await assert.rejects(app.runtime.validateSessionPaths([session]), /Saved history .* conflicts with working directory/);
});

test('session title control rejects unsupported attached hosts without pretending to rename', async t => {
  const app = await fixture(t);
  const session: TopicSession = { id: 'title-session', botId: 1, chatId: -100, threadId: 2,
    instancePath: app.repository, name: 'Title', status: 'open', createdAt: Date.now(),
    runtime: { kind: 'attached', instanceId: 'terminal', sessionId: 'terminal-session' } };
  await assert.rejects(app.runtime.setSessionTitle(session, 'Telegram title'), /native collab registry does not support renaming/);
  await assert.rejects(app.runtime.setSessionTitle(session, '  '), /title cannot be empty/);
});
