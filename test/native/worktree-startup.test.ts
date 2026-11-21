import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TopicSession } from '../../shared/contracts.js';
import { emptyConfig, writeConfig } from '../../src/config.js';
import { OmpRuntime } from '../../src/runtime.js';
import { hostLifecyclePath, hostSupervisorPath } from '../../src/host-assets.js';
import { SessionRetiringError } from '../../src/runtime/types.js';
import { bounded, waitUntil } from '../e2e/helpers/async.js';
import { setupOmpEnvironment } from '../e2e/helpers/omp-environment.js';

test('dormant worktree preparation fences startup and releases ownership after authorization failure', { timeout: 120000 }, async t => {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await bounded(Promise.resolve().then(close), AbortSignal.timeout(30000)); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('\n'));
  });
  const omp = await setupOmpEnvironment({
    signal: t.signal, diagnostic: t.diagnostic.bind(t),
    after: ((close: () => unknown | Promise<unknown>) => { cleanup.push(close); }) as TestContext['after'],
  }, { scenarios: [] });
  const config = emptyConfig(join(omp.dataDir, 'config.yaml'));
  config.dataDir = omp.dataDir;
  config.instances = [{ id: 1, defaultDir: omp.workspace, chats: [] }];
  config.omp = { executable: omp.executable, args: [...omp.args, '--no-skills'], maxSessions: 1, startupTimeoutMs: 60000 };
  const runtime = new OmpRuntime(config);
  writeConfig(config);
  const session: TopicSession = {
    id: randomUUID(), instanceId: 1, botId: 1, chatId: 1, threadId: 1, cwd: omp.workspace,
    name: 'Dormant worktree', runtime: { kind: 'managed' }, status: 'open', createdAt: Date.now(),
  };
  cleanup.push(async () => { try { await runtime.kill(session); } finally { await runtime.close(); } });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const diagnostic = new Error('Native worktree authorization revoked before relocation');
  const switching = runtime.worktree(session, 'blocked-worktree', async () => {
    if (!await runtime.existingBinding(session)) return;
    entered.resolve();
    await resume.promise;
    throw diagnostic;
  });
  const rejected = assert.rejects(switching, error => error === diagnostic);
  cleanup.push(async () => { resume.resolve(); await rejected; });
  await bounded(Promise.race([entered.promise, rejected]), AbortSignal.any([t.signal, AbortSignal.timeout(config.omp.startupTimeoutMs)]));
  await assert.rejects(runtime.ensure(session), SessionRetiringError);
  await assert.rejects(runtime.worktree(session, 'concurrent-worktree'), /OMP runtime is stopping/);
  resume.resolve();
  await rejected;
  const original = await runtime.existingBinding(session);
  assert.ok(original);
  const directory = join(omp.dataDir, 'sessions', session.id);
  const pin = JSON.parse(await readFile(join(directory, 'binding.json'), 'utf8')) as { sessionFile: string };
  const marker = join(omp.dataDir, 'unpublished-host.pid');
  const gate = join(omp.dataDir, 'unpublished-omp');
  await writeFile(gate, `#!/bin/sh\nprintf '%s' "$$" > '${marker}'\nkill -STOP "$$"\nexec '${omp.executable}' "$@"\n`, { mode: 0o700 });
  const supervisor = spawn(process.execPath, [
    hostSupervisorPath, gate, ...config.omp.args, '--cwd', session.cwd,
    '--session-dir', directory, '--resume', pin.sessionFile, '--extension', hostLifecyclePath,
  ], { cwd: session.cwd, env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: directory }, stdio: 'ignore' });
  const exited = once(supervisor, 'exit');
  void exited.catch(error => omp.log('native.unpublished-host.exit.failure', String(error)));
  let pausedPid: number | undefined;
  cleanup.push(async () => {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
    if (pausedPid !== undefined) process.kill(pausedPid, 'SIGKILL');
    else supervisor.kill('SIGKILL');
    await exited;
  });
  const startup = waitUntil(async () => {
    try { return Number(await readFile(marker, 'utf8')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }, pid => pid !== undefined && pid > 1, AbortSignal.any([t.signal, AbortSignal.timeout(config.omp.startupTimeoutMs)]));
  pausedPid = await Promise.race([startup, exited.then(() => { throw new Error('Unpublished host exited before reaching its startup gate'); })]);
  await assert.rejects(runtime.worktree(session, 'prepared-worktree'), error => {
    assert.ok(error instanceof Error && 'errcode' in error && error.errcode === 5);
    t.diagnostic(error.message);
    return true;
  });
  assert.equal(await omp.git(omp.workspace, 'for-each-ref', '--format=%(refname)', 'refs/heads/prepared-worktree'), '');
  assert.deepEqual((await omp.launches()).filter(args => args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'rpc'), []);
  process.kill(pausedPid!, 'SIGKILL');
  await exited;
  await runtime.worktree(session, 'prepared-worktree');
  await omp.assertWorktree(session, 'prepared-worktree');
  assert.deepEqual(await runtime.existingBinding(session), original);
  const launches = await omp.launches();
  assert.deepEqual(launches.filter(args => args.includes('--session-dir')), []);
  assert.equal(await runtime.isRunning(session), false);
  const binding = await runtime.ensure(session);
  assert.equal(binding.sessionId, original.sessionId);
  const managed = (await omp.launches()).filter(args => args.includes('--session-dir'));
  assert.deepEqual(managed.map(args => args[args.indexOf('--cwd') + 1]), [session.cwd]);
});
