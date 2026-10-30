import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from '@lydell/node-pty';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { OmpRuntime } from '../src/runtime.js';
import { connectCollab } from '../src/collab.js';
import { startLocalRelay } from './local-relay.js';
import { writeConfig } from '../src/config.js';

const execute = promisify(execFile);

async function exists(filename: string): Promise<boolean> {
  try { await readFile(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(label);
    await delay(25);
  }
}

export async function verifyRuntimeKill(directory: string, executable: string, relayUrl: string): Promise<void> {
  const config: AppConfig = {
    bots: [], instances: { [directory]: { chats: [] } }, configPath: join(directory, 'config.yaml'),
    publicUrl: 'https://localhost:3000', host: '127.0.0.1', port: 3000, dataDir: directory,
    omp: {
      executable,
      args: ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title'],
      maxSessions: 2, startupTimeoutMs: 60000, relayUrl,
    },
  };
  writeConfig(config);
  const managed: TopicSession = {
    id: 'runtime-kill-managed', botId: 123, chatId: -100123, threadId: 41,
    instancePath: directory,
    name: 'Kill smoke managed', status: 'open', runtime: { kind: 'managed' }, createdAt: Date.now(),
  };
  const attachedId = randomUUID();
  const history = join(directory, 'attached-history.jsonl');
  const overlay = join(directory, 'attached-runtime.json');
  const extension = join(directory, 'hold-extension.mjs');
  const started = join(directory, 'hold-started');
  const finished = join(directory, 'hold-finished');
  const release = join(directory, 'hold-release');
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: attachedId, timestamp: new Date().toISOString(), cwd: directory }) + '\n');
  await writeFile(overlay, JSON.stringify({ collab: { autoStart: 'control', relayUrl }, startup: { checkUpdate: false, setupWizard: false } }));
  await writeFile(extension, `import {existsSync,writeFileSync} from 'node:fs';
export default pi=>pi.registerCommand('kill-hold',{description:'Hold a local command without a model request',handler:async()=>{
  writeFileSync(${JSON.stringify(started)},'holding');
  while(!existsSync(${JSON.stringify(release)})){const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,20);await promise;}
  writeFileSync(${JSON.stringify(finished)},'finished');
}});`);
  let runtime = new OmpRuntime(config);
  let terminal: pty.IPty | undefined;
  let terminalExited = false;
  let terminalOutput = '';
  let attached: TopicSession | undefined;
  const startingSession = { ...managed, id: 'runtime-kill-started-process' };
  try {
    const first = await runtime.ensure(managed);
    const managedDirectory = join(directory, 'sessions', managed.id);
    await waitFor(() => exists(join(managedDirectory, 'lifecycle.json')), 'Managed lifecycle descriptor was not published');
    const lifecycle = JSON.parse(await readFile(join(managedDirectory, 'lifecycle.json'), 'utf8')) as { pid: number };
    const historyBefore = await readFile(join(managedDirectory, 'history.jsonl'), 'utf8');
    runtime.markPrompt(managed.id);
    await runtime.close();
    assert.equal(await alive(lifecycle.pid), true, 'service shutdown must preserve a protected host');
    runtime = new OmpRuntime(config);
    await runtime.kill(managed);
    assert.equal(await alive(lifecycle.pid), false, 'kill must terminate a recovered managed host without first ensuring it');
    assert.equal(await readFile(join(managedDirectory, 'history.jsonl'), 'utf8'), historyBefore, 'forceful kill must preserve managed history bytes');
    await runtime.kill(managed);
    assert.equal(await runtime.isRunning(managed), false, 'repeated kill must not launch a dead host');
    const resumed = await runtime.ensure(managed);
    assert.equal(resumed.sessionId, first.sessionId, 'managed kill must preserve the exact conversation');
    assert.notEqual(resumed.instanceId, first.instanceId, 'resuming after kill must use a fresh process');
    const guest = await connectCollab(resumed, 'Kill history verifier', {
      onFrame(frame) { if (frame.t === 'welcome') assert.equal(frame.header.id, first.sessionId); },
      onClose() {},
    });
    guest.close();
    await waitFor(() => exists(join(managedDirectory, 'lifecycle.json')), 'Resumed lifecycle descriptor was not published');
    const resumedLifecycle = JSON.parse(await readFile(join(managedDirectory, 'lifecycle.json'), 'utf8')) as { pid: number };

    terminal = pty.spawn(executable, [
      '--cwd', directory, '--session-dir', directory, '--resume', history, '--config', overlay,
      ...config.omp.args, '--extension', extension,
    ], { cwd: directory, env: { ...process.env, TERM: 'xterm-256color' }, name: 'xterm-256color', cols: 100, rows: 30 });
    terminal.onExit(() => { terminalExited = true; });
    terminal.onData(part => { terminalOutput = (terminalOutput + part).slice(-4000); });
    let instanceId: string | undefined;
    await waitFor(async () => {
      const { stdout } = await execute(executable, ['collab', 'list', '--json'], { cwd: directory });
      const registry = JSON.parse(stdout) as { hosts: { instanceId: string; sessionId: string; pid: number }[] };
      const host = registry.hosts.find(value => value.sessionId === attachedId && value.pid === terminal!.pid);
      instanceId = host?.instanceId;
      return Boolean(instanceId);
    }, 'Attached host did not register');
    attached = { ...managed, id: 'runtime-kill-attached', threadId: 42, runtime: { kind: 'attached', instanceId: instanceId!, sessionId: attachedId } };
    await runtime.ensure(attached);
    await assert.rejects(runtime.kill({ ...attached, runtime: { kind: 'attached', instanceId: instanceId!, sessionId: 'wrong-conversation' } }), /identity changed/);
    assert.equal(terminalExited, false, 'identity mismatch must never terminate the attached process');
    terminal.write('/kill-hold\r');
    await waitFor(() => exists(started), `Attached command did not start: ${terminalOutput}`);
    await runtime.stop(attached.id);
    assert.equal(terminalExited, false, 'graceful managed retirement must not terminate an attached host');
    const killing = runtime.kill(attached);
    assert.equal(runtime.kill(attached), killing, 'concurrent kills must share one operation');
    await assert.rejects(runtime.ensure(attached), /stopping/);
    assert.throws(() => runtime.retain(attached!.id), /retiring/);
    await killing;
    await waitFor(() => terminalExited, 'Busy attached host did not exit after kill');
    assert.equal(await exists(finished), false, 'kill must terminate the active command without waiting for graceful completion');
    assert.equal(await alive(resumedLifecycle.pid), true, 'killing the attached host must leave the unrelated managed host alive');
    assert.equal(await runtime.isRunning(managed), true, 'unrelated host must remain registered');
    await runtime.kill(attached);
    assert.equal(await runtime.isRunning(attached), false, 'killing a dead attached host must not start a host');

    const cancelled = { ...managed, id: 'runtime-kill-startup' };
    const starting = runtime.ensure(cancelled);
    const rejectedStartup = assert.rejects(starting, /stopping/);
    await runtime.kill(cancelled);
    await rejectedStartup;
    assert.equal(await runtime.isRunning(cancelled), false, 'kill during admission must not launch a host');
    const startingProcess = runtime.ensure(startingSession);
    void startingProcess.catch(() => {});
    let supervisorPid: number | undefined;
    await waitFor(async () => {
      const children = await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8');
      for (const value of children.trim().split(/\s+/).filter(Boolean)) {
        try {
          const argv = (await readFile(`/proc/${value}/cmdline`, 'utf8')).split('\0');
          if (argv.includes(fileURLToPath(new URL('../src/host-supervisor.mjs', import.meta.url))) &&
              argv.includes(join(directory, 'sessions', startingSession.id, 'history.jsonl'))) {
            supervisorPid = Number(value);
            return true;
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return false;
    }, 'Managed startup supervisor was not spawned');
    await runtime.kill(startingSession);
    await assert.rejects(startingProcess, /stopping/);
    await waitFor(async () => !await alive(supervisorPid!), 'Cancelled startup supervisor did not exit');
    assert.equal(await runtime.isRunning(startingSession), false, 'kill during process startup must leave no serving host');
    const retiring = runtime.stop(managed.id);
    await runtime.kill(managed);
    await retiring;
    assert.equal(await alive(resumedLifecycle.pid), false, 'kill must safely supersede concurrent graceful retirement');
    console.log('PASS actual OMP forceful busy attached kill, recovered managed kill, exact-history resume, identity refusal, unrelated-host isolation, startup cancellation, and concurrent retirement.');
  } finally {
    if (attached && !terminalExited) await runtime.kill(attached).catch(() => {});
    if (terminal && !terminalExited) {
      terminal.kill('SIGKILL');
      await waitFor(() => terminalExited, 'Disposable attached host cleanup failed');
    }
    await runtime.kill(startingSession).catch(() => {});
    await runtime.kill(managed).catch(() => {});
    await runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-runtime-kill-smoke-'));
  const relay = await startLocalRelay();
  try {
    await verifyRuntimeKill(directory, process.env.OMP_EXECUTABLE ?? 'omp', relay.url);
    console.log('No model prompt or live Telegram API request was sent.');
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
}
