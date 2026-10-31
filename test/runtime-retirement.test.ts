import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

const execute = promisify(execFile);
type RetirementMode = 'busy' | 'uncertain' | 'accepted' | 'delayed' | 'never-received' | 'cancel-failure';
interface RetirementRequest {
  type: 'retire'; requestId: string; sessionId: string; pid: number; deadline: number; guard: 'idle' | 'none';
}

async function fixture(mode: RetirementMode = 'busy', pid = process.pid, guard: RetirementRequest['guard'] = 'idle') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-retirement-')));
  const dataDir = join(directory, 'data');
  const sessionDir = join(dataDir, 'sessions', 'topic');
  await mkdir(sessionDir, { recursive: true });
  const executable = join(directory, 'omp');
  const statePath = join(directory, 'registry.json');
  const startedPidPath = join(directory, 'started.pid');
  const socketPath = join(directory, 'host.sock');
  const lifecyclePath = join(sessionDir, 'lifecycle.json');
  const host = { instanceId: 'fixture-host', sessionId: 'fixture-session', generation: 7,
    pid, cwd: directory, access: 'control', relayConnected: true, busy: false };
  const url = `wss://localhost/r/fixture-room.${Buffer.alloc(48, 1).toString('base64url')}`;
  const state: { host: typeof host | undefined; failLink: boolean; startupHost?: typeof host } = { host, failLink: false };
  const persistRegistry = () => writeFile(statePath, JSON.stringify(state));
  await persistRegistry();
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (process.argv[2] !== 'collab') {
  if (!state.startupHost) throw new Error('Unexpected managed host startup');
  if (state.host) throw new Error('Managed host startup requires an empty host registry');
  const host = { ...state.startupHost, pid: process.pid };
  const socketPath = ${JSON.stringify(join(directory, 'started.sock'))};
  const server = net.createServer(socket => socket.destroy());
  server.listen(socketPath, () => {
    fs.writeFileSync(${JSON.stringify(startedPidPath)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(lifecyclePath)}, JSON.stringify({
      pid: process.pid, supervisorPid: Number(process.env.OMP_TELEGRAM_SUPERVISOR_PID),
      sessionId: host.sessionId, socketPath, retiring: false, worktree: true
    }));
    fs.writeFileSync(statePath, JSON.stringify({ ...state, host, failLink: false }));
  });
} else if (process.argv[3] === 'link') {
  if (state.failLink) { process.stderr.write('Original reconnect registry failure\\n'); process.exit(23); }
  console.log(JSON.stringify({version:1,instanceId:state.host.instanceId,generation:state.host.generation,access:'control',url:${JSON.stringify(url)}}));
} else console.log(JSON.stringify({version:1,hosts:state.host?[state.host]:[]}));
`);
  await chmod(executable, 0o700);
  const history = join(sessionDir, 'history.jsonl');
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: host.sessionId, cwd: directory }) + '\n');
  await writeFile(join(sessionDir, 'binding.json'), JSON.stringify({ version: 1, sessionId: host.sessionId, sessionFile: history, cwd: directory }));
  const descriptor: { pid: number; supervisorPid: number; sessionId: string; socketPath: string; retiring: boolean; worktree: boolean; retirement?: number } = {
    pid, supervisorPid: process.ppid, sessionId: host.sessionId, socketPath, retiring: false, worktree: true, retirement: 1 };
  const persistLifecycle = () => writeFile(lifecyclePath, JSON.stringify(descriptor));
  await persistLifecycle();
  const requests: RetirementRequest[] = [];
  const delayed = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const handled: Promise<void>[] = [];
  const failures: unknown[] = [];
  const grantPath = (requestId: string) => join(sessionDir, `retirement-${requestId}.request`);
  async function accept(request: RetirementRequest): Promise<boolean> {
    if (request.sessionId !== descriptor.sessionId || request.pid !== descriptor.pid || Date.now() >= request.deadline) return false;
    const next = { ...descriptor, retiring: true };
    try {
      await writeFile(grantPath(request.requestId), JSON.stringify(next), { flag: 'r+' });
      await rename(grantPath(request.requestId), lifecyclePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    Object.assign(descriptor, next);
    return true;
  }
  const sockets = new Set<Socket>();
  const handleConnection = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (mode === 'never-received') { socket.pause(); return; }
    let input = '';
    socket.on('data', data => {
      input += data.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.trim()) as RetirementRequest;
      requests.push(request);
      received.resolve();
      handled.push((async () => {
        const respond = (outcome: 'requested' | 'busy' | 'expired') => socket.end(JSON.stringify({ requestId: request.requestId, sessionId: descriptor.sessionId, pid: descriptor.pid, outcome }) + '\n');
        assert.equal(request.type, 'retire');
        assert.equal(request.guard, guard);
        assert.match(request.requestId, /^[0-9a-f-]{36}$/);
        assert.equal(await readFile(grantPath(request.requestId), 'utf8'), '', 'runtime must close an empty exclusive grant before sending');
        if (mode === 'busy') { respond('busy'); return; }
        if (mode === 'cancel-failure') {
          await rm(grantPath(request.requestId));
          await mkdir(grantPath(request.requestId));
          socket.destroy();
          return;
        }
        if (mode === 'delayed') await delayed.promise;
        const accepted = await accept(request);
        if (mode !== 'uncertain') respond(accepted ? 'requested' : 'expired');
      })().catch(error => { failures.push(error); socket.destroy(); }));
    });
  };
  const server = createServer(handleConnection);
  const servers = [server];
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  const config: AppConfig = { bots: [], instances: { [directory]: { chats: [] } },
    configPath: join(directory, 'config.yaml'), publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000, dataDir,
    omp: { executable, args: [], maxSessions: 1, startupTimeoutMs: 10000 } };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  const session: TopicSession = { id: 'topic', botId: 1, chatId: -100, threadId: 2,
    instancePath: directory, name: 'Regression', status: 'open', createdAt: Date.now(), runtime: { kind: 'managed' } };
  return { runtime, config, session, host, requests, descriptor, persistLifecycle, sessionDir, grantPath, accept, received: received.promise,
    async release() { delayed.resolve(); await Promise.all(handled); assert.deepEqual(failures, []); },
    async grants() { return (await readdir(sessionDir)).filter(name => /^retirement-.*\.request$/.test(name)); },
    async failLink(value: boolean) { state.failLink = value; await persistRegistry(); },
    async prepareHostStartup() {
      state.host = undefined;
      state.startupHost = { ...host, instanceId: 'replacement-host', generation: host.generation + 1 };
      await persistRegistry();
    },
    async replaceHost(pid = host.pid) {
      host.pid = pid;
      host.instanceId = 'replacement-host';
      host.generation++;
      descriptor.pid = pid;
      descriptor.socketPath = join(directory, `replacement-${randomUUID()}.sock`);
      descriptor.retiring = false;
      const replacement = createServer(handleConnection);
      servers.push(replacement);
      const listening = Promise.withResolvers<void>();
      replacement.once('error', listening.reject);
      replacement.listen(descriptor.socketPath, listening.resolve);
      await listening.promise;
      await persistLifecycle();
      state.host = host;
      state.failLink = false;
      await persistRegistry();
    },
    async originalError() {
      try { await execute(executable, ['collab', 'link', host.instanceId, '--json'], { cwd: dataDir }); }
      catch (error) { return error as Error & { code: number; signal: string | null }; }
      throw new Error('Expected registry failure');
    },
    async close() {
      delayed.resolve();
      await Promise.all(handled);
      const startedPid = await readFile(startedPidPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (startedPid) {
        try { process.kill(Number(startedPid), 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await writeFile(statePath, JSON.stringify({ ...state, host: undefined }));
      await rm(lifecyclePath, { force: true });
      await runtime.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        return closed.promise;
      }));
      await rm(directory, { recursive: true, force: true });
      assert.deepEqual(failures, []);
    },
  };
}

test('existing managed reconnect failure preserves its error without retiring the host, then retries the same host', async t => {
  const app = await fixture();
  t.after(() => app.close());
  const initial = await app.runtime.ensure(app.session);
  await app.failLink(true);
  const original = await app.originalError();
  await assert.rejects(app.runtime.ensure(app.session), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, original.message);
    assert.equal((error as NodeJS.ErrnoException).code, original.code);
    assert.equal('signal' in error ? error.signal : undefined, original.signal);
    return true;
  });
  assert.deepEqual(app.requests, [], 'reconnect failure must not retire an existing host');
  await app.failLink(false);
  assert.deepEqual(await app.runtime.ensure(app.session), initial);
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
});

test('explicit retirement discovers a surviving managed host before any reconnect', async t => {
  const app = await fixture('accepted', process.pid, 'none');
  t.after(() => app.close());
  await app.runtime.stop(app.session.id);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0]!.guard, 'none');
  assert.equal(app.requests[0]!.sessionId, app.descriptor.sessionId);
  assert.equal(app.descriptor.retiring, true);
  assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
});

test('automatic idle retirement lets the host authoritatively reject busy retirement', async t => {
  const app = await fixture('busy');
  t.after(() => app.close());
  const initial = await app.runtime.ensure(app.session);
  const retirement = app.runtime.retireIdle(0);
  assert.throws(() => app.runtime.retain(app.session.id), /Session is retiring/);
  assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
  await assert.rejects(app.runtime.ensure(app.session), /OMP runtime is stopping/);
  assert.equal(await retirement, 0);
  assert.equal(app.descriptor.retiring, false, 'busy host must not begin retirement');
  assert.deepEqual(await app.grants(), []);
  assert.deepEqual(await app.runtime.ensure(app.session), initial);
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
});

test('automatic idle retirement leaves unsupported hosts available without unconditional fallback', async t => {
  const app = await fixture('busy');
  t.after(() => app.close());
  delete app.descriptor.retirement;
  await app.persistLifecycle();
  const initial = await app.runtime.ensure(app.session);
  assert.equal(await app.runtime.retireIdle(0), 0);
  assert.deepEqual(app.requests, []);
  assert.equal(app.descriptor.retiring, false);
  assert.deepEqual(await app.runtime.ensure(app.session), initial);
  await assert.rejects(app.runtime.stop(app.session.id), /does not support safe retirement/);
  assert.deepEqual(app.requests, [], 'explicit retirement must not fall back to an unsafe protocol');
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
});

for (const mode of ['delayed', 'never-received'] as const) {
  test(`${mode} retirement is conclusively cancelled before prompt admission reopens`, async t => {
    const app = await fixture(mode);
    t.after(() => app.close());
    const initial = await app.runtime.ensure(app.session);
    const retirement = app.runtime.retireIdle(0);
    if (mode === 'delayed') await app.received;
    assert.equal(await retirement, 0);
    assert.deepEqual(await app.grants(), [], 'cancellation must revoke grants before returning');
    assert.equal(app.descriptor.retiring, false);
    assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
    await app.release();
    assert.equal(app.descriptor.retiring, false, 'buffered request must not retire the now-admitting host');
    assert.deepEqual(await app.runtime.ensure(app.session), initial);
    assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
  });
}

test('unresolved cancellation I/O failure keeps admission blocked and preserves the original error across reconnect', async t => {
  const app = await fixture('cancel-failure');
  t.after(() => app.close());
  await app.runtime.ensure(app.session);
  let original: unknown;
  await assert.rejects(app.runtime.retireIdle(0), error => {
    original = error;
    assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
    return true;
  });
  assert.equal(app.descriptor.retiring, false);
  assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
  assert.throws(() => app.runtime.retain(app.session.id), /Session is retiring/);
  await assert.rejects(app.runtime.ensure(app.session), error => {
    assert.equal(error, original);
    return true;
  });
  assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
});

test('cancellation error stops fencing an adopted host after verified exit and allows a replacement', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid);
  const app = await fixture('cancel-failure', pid);
  t.after(() => app.close());
  await app.runtime.ensure(app.session);
  let original: unknown;
  await assert.rejects(app.runtime.retireIdle(0), error => {
    original = error;
    assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
    return true;
  });
  for (const grant of await app.grants()) await rm(join(app.sessionDir, grant), { recursive: true });
  await assert.rejects(app.runtime.ensure(app.session), error => error === original);
  child.kill();
  await exited;
  await app.prepareHostStartup();
  assert.equal((await app.runtime.ensure(app.session)).instanceId, 'replacement-host');
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
  const release = app.runtime.retain(app.session.id);
  release();
});

test('cancellation error stops fencing a validated replacement with the same PID and a new lifecycle socket', async t => {
  const app = await fixture('cancel-failure');
  t.after(() => app.close());
  await app.runtime.ensure(app.session);
  const pid = app.host.pid;
  const socketPath = app.descriptor.socketPath;
  let original: unknown;
  await assert.rejects(app.runtime.retireIdle(0), error => {
    original = error;
    assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
    return true;
  });
  for (const grant of await app.grants()) await rm(join(app.sessionDir, grant), { recursive: true });
  await assert.rejects(app.runtime.ensure(app.session), error => error === original);
  assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
  await app.replaceHost();
  assert.equal(app.host.pid, pid);
  assert.notEqual(app.descriptor.socketPath, socketPath);
  assert.equal((await app.runtime.ensure(app.session)).instanceId, 'replacement-host');
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
  const release = app.runtime.retain(app.session.id);
  release();
});

test('new runtime ownership revokes stale grants before managed admission, and stale buffered requests cannot publish', async t => {
  const app = await fixture();
  const restarted = new OmpRuntime(app.config);
  t.after(async () => { await restarted.close(); await app.close(); });
  await app.runtime.ensure(app.session);
  await app.runtime.close();
  const stale: RetirementRequest = { type: 'retire', requestId: randomUUID(), sessionId: app.host.sessionId, pid: app.host.pid, deadline: Date.now() + 10000, guard: 'idle' };
  await writeFile(app.grantPath(stale.requestId), '', { flag: 'wx', mode: 0o600 });
  await restarted.ensure(app.session);
  assert.deepEqual(await app.grants(), []);
  assert.equal(await app.accept(stale), false, 'unexpired buffered request from former owner must lose its grant');
  assert.equal(app.descriptor.retiring, false);
  assert.doesNotThrow(() => restarted.markPrompt(app.session.id));
});

for (const mode of ['uncertain', 'accepted'] as const) {
  test(`${mode} retirement acknowledgement keeps a still-running retiring host blocked`, async t => {
    const app = await fixture(mode);
    t.after(() => app.close());
    await app.runtime.ensure(app.session);
    assert.equal(await app.runtime.retireIdle(0), 0);
    assert.equal(app.descriptor.retiring, true);
    assert.deepEqual(await app.grants(), []);
    assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
    assert.throws(() => app.runtime.retain(app.session.id), /Session is retiring/);
    await assert.rejects(app.runtime.ensure(app.session), /Session is retiring/);
    assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
    assert.equal(await app.runtime.retireIdle(0), 0);
    assert.equal(app.requests.length, 1, 'accepted retirement must not be requested again');
    if (mode === 'accepted') {
      await app.replaceHost(process.ppid);
      const replacement = await app.runtime.ensure(app.session);
      assert.equal(replacement.instanceId, 'replacement-host');
      assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
      const release = app.runtime.retain(app.session.id);
      release();
    }
  });
}

test('accepted retirement admits a validated replacement reusing its PID with a new lifecycle socket', async t => {
  const app = await fixture('accepted');
  t.after(() => app.close());
  await app.runtime.ensure(app.session);
  const pid = app.host.pid;
  const socketPath = app.descriptor.socketPath;
  assert.equal(await app.runtime.retireIdle(0), 0);
  assert.equal(app.descriptor.retiring, true);
  await assert.rejects(app.runtime.ensure(app.session), /Session is retiring/);
  assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
  await app.replaceHost();
  assert.equal(app.host.pid, pid);
  assert.notEqual(app.descriptor.socketPath, socketPath);
  assert.equal(app.descriptor.retiring, false);
  assert.equal((await app.runtime.ensure(app.session)).instanceId, 'replacement-host');
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
  const release = app.runtime.retain(app.session.id);
  release();
  assert.equal(app.requests.length, 1, 'replacement admission must not send another retirement request');
});
