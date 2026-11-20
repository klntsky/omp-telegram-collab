import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import type { CollabConnection, HostBinding, TopicSession } from '../../shared/contracts.js';
import { emptyConfig, writeConfig } from '../../src/config.js';
import { hostLifecyclePath, hostSupervisorPath } from '../../src/host-assets.js';
import { startLocalRelay } from '../../src/local-relay.js';
import { OmpRuntime } from '../../src/runtime.js';
import { childEnvironment } from '../../src/runtime/environment.js';
import { belongsTo, procIdentity } from '../../src/runtime/process.js';
import { parseCollabLink } from '../../src/vendor/link.js';
import { SessionCapacityError } from '../../src/runtime/types.js';
import { bounded, waitUntil } from '../e2e/helpers/async.js';
import { createWriteTask, readSessionHistory, writeScenario, type WriteTask } from '../e2e/helpers/model-tasks.js';
import { setupOmpEnvironment } from '../e2e/helpers/omp-environment.js';
import { interruptManagedRelay } from '../e2e/helpers/relay.js';

test('managed relay preserves native history through foreign-relay cutover, service restart and relay crash', { timeout: 240000 }, async t => {
  const tasks = [createWriteTask('before-cutover'), createWriteTask('after-relay-crash')];
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
  }, { telegramSecrets: false, scenarios: tasks.map(task => writeScenario(task)) });
  const foreign = await startLocalRelay();
  cleanup.push(() => foreign.close());
  const config = emptyConfig(join(omp.dataDir, 'config.yaml'));
  config.dataDir = omp.dataDir;
  config.instances = [{ id: 1, defaultDir: omp.workspace, chats: [] }];
  config.omp = { executable: omp.executable, args: [...omp.args, '--no-skills'], maxSessions: 1, startupTimeoutMs: 60000 };
  writeConfig(config);
  const session: TopicSession = {
    id: randomUUID(), instanceId: 1, botId: 1, chatId: 1, threadId: 1, cwd: omp.workspace,
    name: 'Managed relay acceptance', runtime: { kind: 'managed' }, status: 'open', createdAt: Date.now(),
  };
  const directory = join(omp.dataDir, 'sessions', session.id);
  const sessionId = randomUUID();
  const sessionFile = join(directory, 'history.jsonl');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: session.cwd, timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ version: 1, sessionId, sessionFile, cwd: session.cwd }), { mode: 0o600 });
  await writeFile(join(directory, 'runtime.yml'), JSON.stringify({ collab: { autoStart: 'control', relayUrl: foreign.url }, startup: { checkUpdate: false, setupWizard: false } }), { mode: 0o600 });
  let runtime = new OmpRuntime(config);
  cleanup.push(async () => { try { await runtime.kill(session); } finally { await runtime.close(); } });
  async function startForeignHost(): Promise<void> {
    const args = [hostSupervisorPath, omp.executable, ...config.omp.args,
      '--cwd', session.cwd, '--config', join(directory, 'runtime.yml'), '--session-dir', directory,
      '--resume', sessionFile, '--no-title', '--extension', hostLifecyclePath,
    ];
    omp.log('native.foreign.launch', { args, overlay: JSON.parse(await readFile(join(directory, 'runtime.yml'), 'utf8')), sessionId });
    const supervisor = spawn(process.execPath, args,
      {
        cwd: session.cwd,
        // This fixture has no preset; do not inherit the enclosing OMP host's forum preset.
        env: { ...childEnvironment(), OMP_TELEGRAM_SESSION_DIR: directory, OMP_TELEGRAM_DEFAULT_PRESET: '' },
        stdio: 'ignore', detached: true,
      });
    supervisor.unref();
    supervisor.once('exit', (code, signal) => omp.log('native.foreign.exit', { pid: supervisor.pid, code, signal }));
    cleanup.push(async () => {
      if (!supervisor.pid || supervisor.exitCode !== null || supervisor.signalCode !== null) return;
      // This pre-cutover process is created by the fixture, before runtime
      // admission owns it. Reap it even if startup never publishes a lifecycle.
      let children: string;
      try { children = await readFile(`/proc/${supervisor.pid}/task/${supervisor.pid}/children`, 'utf8'); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
      const errors: unknown[] = [];
      for (const pid of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        try {
          if (await belongsTo(pid, supervisor.pid)) process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) errors.push(error);
        }
      }
      try { supervisor.kill('SIGKILL'); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, errors.map(String).join('\n'));
    });
    const spawned = Promise.withResolvers<void>();
    supervisor.once('spawn', spawned.resolve);
    supervisor.once('error', spawned.reject);
    await spawned.promise;
  }
  await startForeignHost();
  const signal = () => AbortSignal.any([t.signal, AbortSignal.timeout(60000)]);
  let hosts;
  try {
    hosts = await waitUntil(() => omp.listHosts(), hosts => hosts.some(host => host.sessionId === sessionId), signal());
  } catch (error) {
    for (const filename of ['runtime.yml', 'lifecycle.json', 'startup-preset.json']) {
      try { omp.log('native.foreign.startup-state', { filename, value: JSON.parse(await readFile(join(directory, filename), 'utf8')) }); }
      catch (diagnosticError) { omp.log('native.foreign.startup-state', { filename, error: String(diagnosticError) }); }
    }
    throw error;
  }
  const original = hosts.find(host => host.sessionId === sessionId)!;
  let connection: CollabConnection | undefined;
  cleanup.push(() => connection?.close());
  async function runTask(binding: HostBinding, task: WriteTask): Promise<void> {
    const frames: HostFrame[] = [];
    let expectedClose = false;
    const ended = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<never>();
    void closed.promise.catch(error => omp.log('native.relay.connection.failure', { error: String(error) }));
    connection = await runtime.connectCollab(binding, 'Relay acceptance', {
      onFrame(frame) {
        frames.push(frame);
        runtime.observeFrame(session.id, frame);
        if (frame.t === 'event' && frame.event.type === 'agent_end') ended.resolve();
      },
      onClose(reason) { if (!expectedClose) closed.reject(new Error(reason)); },
    }, t.signal);
    try {
      runtime.markPrompt(session.id);
      connection.send({ t: 'prompt', text: task.prompt });
      await bounded(Promise.race([ended.promise, closed.promise, omp.provider.failure]), signal());
      assert.deepEqual(JSON.parse(await readFile(join(session.cwd, task.path), 'utf8')), task.evidence);
      assert.ok(frames.some(frame => frame.t === 'entry' && frame.entry.type === 'message' &&
        frame.entry.message.role === 'toolResult' && frame.entry.message.toolCallId === task.toolCallId && !frame.entry.message.isError));
    } finally {
      expectedClose = true;
      connection.close();
      connection = undefined;
    }
  }
  const foreignBinding = await runtime.attach(original.instanceId, session.cwd);
  await runTask(foreignBinding, tasks[0]!);
  // A failed relay must not make the process unretirable: cleanup uses the
  // private lifecycle and native idle guard, not successful Collab publication.
  await foreign.close();
  await runtime.prepareManagedRelay([session]);
  await waitUntil(() => procIdentity(original.pid), identity => !identity || identity.state === 'Z' || identity.state === 'X', signal());
  const binding = await runtime.ensure(session);
  assert.equal(binding.sessionId, sessionId);
  const descriptor = async () => JSON.parse(await readFile(join(omp.dataDir, 'local-relay', 'descriptor.json'), 'utf8')) as { pid: number; url: string };
  const relay = await descriptor();
  const parsed = parseCollabLink(binding.url);
  assert.ok(!('error' in parsed));
  assert.equal(new URL(parsed.wsUrl).origin, relay.url);
  assert.equal(new URL(relay.url).hostname, '127.0.0.1');
  const localHost = (await omp.listHosts()).find(host => host.sessionId === sessionId)!;
  assert.notEqual(localHost.pid, original.pid);
  const release = runtime.retain(session.id);
  await runtime.close();
  release();
  runtime = new OmpRuntime(config);
  await runtime.acquire();
  assert.equal((await descriptor()).pid, relay.pid);
  await runtime.ensure(session);
  assert.equal((await omp.listHosts()).find(host => host.sessionId === sessionId)?.pid, localHost.pid);
  await interruptManagedRelay(omp.dataDir);
  const replacement = await waitUntil(descriptor, current => current.pid !== relay.pid, signal());
  assert.equal(replacement.url, relay.url);
  await waitUntil(() => omp.listHosts(), hosts => hosts.some(host => host.sessionId === sessionId && host.relayConnected), signal());
  const recovered = await runtime.ensure(session);
  assert.equal(recovered.sessionId, sessionId);
  assert.equal((await omp.listHosts()).find(host => host.sessionId === sessionId)?.pid, localHost.pid);
  await runTask(recovered, tasks[1]!);
  const history = (await readSessionHistory(omp.dataDir, session.id)).trim().split('\n').map(line => JSON.parse(line));
  for (const task of tasks) assert.equal(history.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === task.toolCallId).length, 1);
  await runtime.kill(session);
  await writeFile(join(directory, 'runtime.yml'), JSON.stringify({ collab: { autoStart: 'control', relayUrl: foreign.url }, startup: { checkUpdate: false, setupWizard: false } }), { mode: 0o600 });
  await startForeignHost();
  const offline = await waitUntil(async () => {
    try { return JSON.parse(await readFile(join(directory, 'lifecycle.json'), 'utf8')) as { pid: number }; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }, value => value !== undefined, signal());
  assert.ok(offline);
  assert.ok(!(await omp.listHosts()).some(host => host.sessionId === sessionId));
  let checkedCapacity = false;
  const resumed = await runtime.ensure(session, async () => {
    const identity = await procIdentity(offline.pid);
    if (checkedCapacity || (identity && identity.state !== 'Z' && identity.state !== 'X')) return;
    checkedCapacity = true;
    await assert.rejects(runtime.reserveSession(randomUUID()), SessionCapacityError);
  });
  assert.equal(checkedCapacity, true);
  assert.equal(resumed.sessionId, sessionId);
  await waitUntil(() => procIdentity(offline.pid), identity => !identity || identity.state === 'Z' || identity.state === 'X', signal());
  const finalHistory = (await readSessionHistory(omp.dataDir, session.id)).trim().split('\n').map(line => JSON.parse(line));
  for (const task of tasks) assert.equal(finalHistory.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === task.toolCallId).length, 1);
  omp.provider.assertComplete();
});
