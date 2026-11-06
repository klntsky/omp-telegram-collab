import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';

const execute = promisify(execFile);

export async function cleanupFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-cleanup-')));
  const repository = join(directory, 'repository');
  const linked = join(directory, 'linked');
  const dataDir = join(directory, 'data');
  const statePath = join(directory, 'hosts.json');
  const executable = join(directory, 'omp');
  const store = new Store(':memory:');
  let runtime: OmpRuntime | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    try { await runtime?.close(); } catch (error) { errors.push(error); }
    try { store.close(); } catch (error) { errors.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
  await mkdir(repository);
  const git = async (cwd: string, ...args: string[]) => (await execute('git', args, {
    cwd, timeout: 10000, env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
  })).stdout.trim();
  await git(repository, 'init', '--initial-branch=main');
  await git(repository, 'config', 'user.name', 'Cleanup fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.test');
  await git(repository, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repository, 'tracked.txt'), 'original\n');
  await git(repository, 'add', 'tracked.txt');
  await git(repository, 'commit', '-m', 'Initialize cleanup fixture');
  await git(repository, 'worktree', 'add', '-b', 'cleanup-target', linked);
  await writeFile(statePath, '[]');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['collab', 'list', '--json'])) throw new Error('Unexpected OMP command');
console.log(JSON.stringify({version:1,hosts:JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'))}));
`);
  await chmod(executable, 0o700);
  const config: AppConfig = {
    bots: [{ id: 1, token: '1:fixture', miniAppShortName: 'app' }],
    instances: [{ id: 1, defaultDir: repository, chats: [{ botId: 1, chatId: -100 }] }],
    configPath: join(directory, 'config.yaml'), dataDir, publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000,
    omp: { executable, args: [], maxSessions: 2, startupTimeoutMs: 10000 },
  };
  writeConfig(config);
  const created = store.createSession({ botId: 1, chatId: -100, threadId: 2, instanceId: 1, cwd: linked }, 'Cleanup', { kind: 'managed' });
  store.updateSession(created.id, { status: 'closed' });
  store.advanceSessionGeneration(created.id);
  const session = store.getSession(created.id)!;
  const sessionDir = join(dataDir, 'sessions', session.id);
  await mkdir(sessionDir, { recursive: true });
  const history = join(sessionDir, 'history.jsonl');
  const binding = join(sessionDir, 'binding.json');
  async function bind(cwd: string, sessionFile = history): Promise<TopicSession> {
    await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'cleanup-history', cwd }) + '\n');
    await writeFile(binding, JSON.stringify({ version: 1, sessionId: 'cleanup-history', sessionFile, cwd }));
    store.setSessionCwd(session.id, cwd);
    return store.getSession(session.id)!;
  }
  await bind(linked);
  runtime = new OmpRuntime(config);
  const activeRuntime = runtime;
  return {
    directory, repository, linked, config, store, session, history, binding, git, bind, runtime: activeRuntime,
    async target() {
      const target = await activeRuntime.inspectWorktree(session);
      assert.ok(target, 'an existing managed binding must identify its linked Git worktree');
      return target;
    },
    async assertRetained() {
      assert.ok((await stat(linked)).isDirectory());
      assert.equal(await readFile(join(repository, 'tracked.txt'), 'utf8'), 'original\n');
      assert.ok((await git(repository, 'worktree', 'list', '--porcelain')).split('\n').includes(`worktree ${linked}`));
      assert.equal(JSON.parse(await readFile(history, 'utf8')).id, 'cleanup-history');
    },
    async hosts(cwds: string[]) {
      await writeFile(statePath, JSON.stringify(cwds.map((cwd, index) => ({
        instanceId: `other-${index}`, sessionId: `other-history-${index}`, generation: 1,
        pid: process.pid, cwd, access: 'control', relayConnected: true, busy: false,
      }))));
    },
  };
}
