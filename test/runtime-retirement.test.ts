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
  const fixtureProcess = mode === 'cancel-failure' && pid === process.pid
    ? spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: directory, stdio: ['pipe', 'ignore', 'ignore'] })
    : undefined;
  const fixtureExited = fixtureProcess ? once(fixtureProcess, 'exit') : undefined;
  if (fixtureProcess) {
    await once(fixtureProcess, 'spawn');
    assert.ok(fixtureProcess.pid);
    pid = fixtureProcess.pid;
  }
  const dataDir = join(directory, 'data');
  const sessionDir = join(dataDir, 'sessions', 'topic');
  await mkdir(sessionDir, { recursive: true });
  const executable = join(directory, 'omp');
  const statePath = join(directory, 'registry.json');
  const startedPidPath = join(directory, 'started.pid');
  const commandsPath = join(directory, 'commands.jsonl');
  await writeFile(commandsPath, '');
  const socketPath = join(directory, 'host.sock');
  const lifecyclePath = join(sessionDir, 'lifecycle.json');
  const host = { instanceId: 'fixture-host', sessionId: 'fixture-session', generation: 7,
    pid, cwd: directory, access: 'control', relayConnected: true, busy: false };
  const url = `wss://localhost/r/fixture-room.${Buffer.alloc(48, 1).toString('base64url')}`;
  const state: { host: typeof host | undefined; failLink: boolean; startupHost?: typeof host; holdStartup?: boolean } = { host, failLink: false };
  const persistRegistry = () => writeFile(statePath, JSON.stringify(state));
  await persistRegistry();
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(process.argv.slice(2))+'\\n');
if (process.argv[2] !== 'collab') {
  if (!state.startupHost) throw new Error('Unexpected managed host startup');
  if (state.host) throw new Error('Managed host startup requires an empty host registry');
  const host = { ...state.startupHost, pid: process.pid };
  const socketPath = ${JSON.stringify(join(directory, 'started.sock'))};
  const descriptor = {pid:process.pid,supervisorPid:Number(process.env.OMP_TELEGRAM_SUPERVISOR_PID),
    sessionId:host.sessionId,socketPath,retiring:false,worktree:true,retirement:1};
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', data => {
      input += data.toString();
      if (!input.includes('\\n')) return;
      const request = JSON.parse(input.trim());
      if (request.type !== 'retire' || request.guard !== 'none' || request.pid !== process.pid ||
          request.sessionId !== host.sessionId) throw new Error('Unexpected startup retirement request');
      descriptor.retiring = true;
      const grant = ${JSON.stringify(sessionDir)}+'/retirement-'+request.requestId+'.request';
      fs.writeFileSync(grant, JSON.stringify(descriptor), {flag:'r+'});
      fs.renameSync(grant, ${JSON.stringify(lifecyclePath)});
      socket.end(JSON.stringify({requestId:request.requestId,sessionId:host.sessionId,pid:process.pid,outcome:'requested'})+'\\n');
      server.close(() => process.exit(0));
    });
  });
  server.listen(socketPath, () => {
    fs.writeFileSync(${JSON.stringify(startedPidPath)}, String(process.pid));
    const publish = () => {
      fs.writeFileSync(${JSON.stringify(lifecyclePath)}, JSON.stringify(descriptor));
      fs.writeFileSync(statePath, JSON.stringify({ ...state, host, failLink: false }));
    };
    if (!state.holdStartup) publish();
    else {
      const control = net.createConnection(${JSON.stringify(socketPath)});
      control.once('connect', () => control.write(JSON.stringify({type:'startup',pid:process.pid,supervisorPid:descriptor.supervisorPid})+'\\n'));
      control.once('data', publish);
    }
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
  const startup = Promise.withResolvers<{ pid: number; supervisorPid: number }>();
  let startupControl: Socket | undefined;
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
      const request = JSON.parse(input.trim()) as RetirementRequest | { type: 'startup'; pid: number; supervisorPid: number };
      if (request.type === 'startup') {
        startupControl = socket;
        startup.resolve({ pid: request.pid, supervisorPid: request.supervisorPid });
        return;
      }
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
  return { runtime, config, session, host, requests, descriptor, persistLifecycle, sessionDir, lifecyclePath, grantPath, accept, received: received.promise,
    async commands() { return (await readFile(commandsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]); },
    async removeHost() { state.host = undefined; await persistRegistry(); },
    waitForStartup() { return startup.promise; },
    async publishStartup() { assert.ok(startupControl); startupControl.end('publish\n'); },
    async release() { delayed.resolve(); await Promise.all(handled); assert.deepEqual(failures, []); },
    async grants() { return (await readdir(sessionDir)).filter(name => /^retirement-.*\.request$/.test(name)); },
    async failLink(value: boolean) { state.failLink = value; await persistRegistry(); },
    async prepareHostStartup(holdStartup = false) {
      state.holdStartup = holdStartup;
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
      if (fixtureProcess) {
        if (fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) fixtureProcess.kill();
        await fixtureExited;
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

test('closed stop recovers only its managed survivor without resolving a capability and tracks retirement until exit', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await once(child, 'spawn');
  assert.ok(child.pid);
  const app = await fixture('accepted', child.pid, 'none');
  t.after(() => app.close());
  await app.failLink(true);
  const unrelated = join(app.config.dataDir, 'sessions', 'unrelated');
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(join(unrelated, 'binding.json'), 'not valid metadata');
  const binding = await readFile(join(app.sessionDir, 'binding.json'), 'utf8');
  const history = await readFile(join(app.sessionDir, 'history.jsonl'), 'utf8');
  const closed: TopicSession = { ...app.session, status: 'closed' };
  const stopping = app.runtime.stop(closed);
  const repeated = app.runtime.stop(closed);
  await app.received;
  await app.release();
  assert.equal(await stopping, false, 'a live retiring host is not absent');
  assert.equal(await repeated, false);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0]?.guard, 'none');
  await app.removeHost();
  assert.equal(await app.runtime.stop(closed), false, 'unregistration alone does not prove process exit');
  assert.equal(await app.runtime.retireIdle(0), 0);
  assert.equal(app.requests.length, 1, 'maintenance and repeated stop must not send another request');
  assert.throws(() => app.runtime.retain(closed.id), /Session is retiring/);
  child.kill();
  await exited;
  await rm(app.lifecyclePath);
  assert.equal(await app.runtime.stop(closed), true);
  assert.equal(await app.runtime.stop(closed), true);
  assert.equal(await readFile(join(app.sessionDir, 'binding.json'), 'utf8'), binding);
  assert.equal(await readFile(join(app.sessionDir, 'history.jsonl'), 'utf8'), history);
  assert.ok((await app.commands()).every(args => args[0] === 'collab' && args[1] === 'list'));
});

test('stop verifies an absent pinned host without recreating metadata, history, or a process', async t => {
  const app = await fixture();
  t.after(() => app.close());
  await app.removeHost();
  await rm(app.lifecyclePath);
  const before = await readdir(app.sessionDir);
  const binding = await readFile(join(app.sessionDir, 'binding.json'), 'utf8');
  const history = await readFile(join(app.sessionDir, 'history.jsonl'), 'utf8');
  assert.equal(await app.runtime.stop(app.session), true);
  assert.deepEqual(await readdir(app.sessionDir), before);
  assert.equal(await readFile(join(app.sessionDir, 'binding.json'), 'utf8'), binding);
  assert.equal(await readFile(join(app.sessionDir, 'history.jsonl'), 'utf8'), history);
  assert.deepEqual(app.requests, []);
  assert.ok((await app.commands()).every(args => args[0] === 'collab' && args[1] === 'list'));
});

test('attached stop leaves terminal ownership and unrelated managed hosts untouched', async t => {
  const app = await fixture();
  t.after(() => app.close());
  const attached: TopicSession = { ...app.session, id: 'attached', status: 'closed',
    runtime: { kind: 'attached', instanceId: app.host.instanceId, sessionId: app.host.sessionId } };
  assert.equal(await app.runtime.stop(attached), true);
  assert.deepEqual(await app.commands(), []);
  assert.deepEqual(app.requests, []);
  assert.equal(app.descriptor.retiring, false);
  assert.equal((await app.runtime.ensure(app.session)).instanceId, app.host.instanceId);
  assert.equal(await app.runtime.stop(attached), true);
  assert.deepEqual(app.requests, []);
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
});

for (const invalid of ['missing', 'unsupported', 'stale-pid', 'stale-history', 'stale-cwd'] as const) {
  test(`recovered stop refuses ${invalid} identity without unsafe fallback`, async t => {
    const app = await fixture('accepted', process.pid, 'none');
    t.after(() => app.close());
    let diagnostic: RegExp = /does not support safe retirement/;
    if (invalid === 'missing') await rm(app.lifecyclePath);
    else if (invalid === 'unsupported') {
      delete app.descriptor.retirement;
      await app.persistLifecycle();
    } else if (invalid === 'stale-pid') {
      app.descriptor.pid = process.ppid;
      await app.persistLifecycle();
      diagnostic = /Managed OMP lifecycle identity changed/;
    } else if (invalid === 'stale-history') {
      await writeFile(join(app.sessionDir, 'history.jsonl'), JSON.stringify({
        type: 'session', version: 3, id: 'another-history', cwd: app.session.instancePath,
      }) + '\n');
      diagnostic = /Managed OMP history identity changed/;
    } else {
      app.host.cwd = tmpdir();
      await app.failLink(false);
      diagnostic = /Managed host working directory changed/;
    }
    await assert.rejects(app.runtime.stop(app.session), diagnostic);
    assert.deepEqual(app.requests, []);
    assert.equal(app.descriptor.retiring, false);
    assert.ok((await app.commands()).every(args => args[0] === 'collab' && args[1] === 'list'));
  });
}

test('maintenance settles a recovered draining host after exact process exit without another request', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await once(child, 'spawn');
  assert.ok(child.pid);
  const app = await fixture('accepted', child.pid, 'none');
  t.after(() => app.close());
  app.descriptor.retiring = true;
  await app.persistLifecycle();
  assert.equal(await app.runtime.stop(app.session), false);
  assert.equal(await app.runtime.stop(app.session), false);
  assert.deepEqual(app.requests, []);
  child.kill();
  await exited;
  assert.equal(await app.runtime.retireIdle(0), 1);
  assert.equal(await app.runtime.retireIdle(0), 0);
  assert.equal(await app.runtime.stop(app.session), true, 'a stale registry PID must not keep an exited host alive');
  assert.deepEqual(app.requests, []);
});

test('stop fences pending admission before it can launch a managed supervisor', async t => {
  const app = await fixture();
  t.after(() => app.close());
  await app.prepareHostStartup();
  await rm(app.lifecyclePath);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let callbacks = 0;
  const starting = app.runtime.ensure(app.session, async () => {
    callbacks++;
    entered.resolve();
    await release.promise;
  });
  const rejected = assert.rejects(starting, /stopping/);
  await entered.promise;
  const stopping = app.runtime.stop({ ...app.session, status: 'closed' });
  release.resolve();
  await rejected;
  assert.equal(await stopping, true);
  assert.equal(callbacks, 1);
  assert.ok((await app.commands()).every(args => args[0] === 'collab'));
});

test('managed startup refreshes mutation authorization after admission and preserves its rejection', async t => {
  const app = await fixture();
  t.after(() => app.close());
  await app.prepareHostStartup();
  await rm(app.lifecyclePath);
  const denied = new Error('Session closed while starting');
  let callbacks = 0;
  await assert.rejects(app.runtime.ensure(app.session, async () => {
    callbacks++;
    if (callbacks === 2) throw denied;
  }), error => error === denied);
  assert.equal(callbacks, 2);
  assert.ok((await app.commands()).every(args => args[0] === 'collab'));
});

test('stop during managed startup waits for lifecycle publication and retires the host and supervisor', async t => {
  const app = await fixture('accepted', process.pid, 'none');
  t.after(() => app.close());
  await app.prepareHostStartup(true);
  await rm(app.lifecyclePath);
  const starting = app.runtime.ensure(app.session);
  const rejected = assert.rejects(starting, /stopping/);
  const { pid, supervisorPid } = await app.waitForStartup();
  const stopping = app.runtime.stop({ ...app.session, status: 'closed' });
  await app.publishStartup();
  await rejected;
  assert.equal(await stopping, true);
  await assert.rejects(readFile(`/proc/${pid}/stat`), { code: 'ENOENT' });
  await assert.rejects(readFile(`/proc/${supervisorPid}/stat`), { code: 'ENOENT' });
  assert.equal(await app.runtime.stop(app.session), true);
  const commands = await app.commands();
  assert.equal(commands.filter(args => args[0] !== 'collab').length, 1);
  assert.equal(commands.filter(args => args[0] === 'collab' && args[1] === 'link').length, 0);
});

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
  await assert.rejects(app.runtime.stop(app.session), /does not support safe retirement/);
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

test('reopened admission keeps an adopted draining host fenced after it leaves the registry', async t => {
  const app = await fixture('accepted');
  t.after(() => app.close());
  app.descriptor.retiring = true;
  await app.persistLifecycle();
  await assert.rejects(app.runtime.ensure(app.session), /Session is retiring/);
  await app.removeHost();
  await assert.rejects(app.runtime.ensure(app.session), /Session is retiring/);
  await assert.rejects(app.runtime.ensure({ ...app.session, id: 'another-topic' }), /OMP session limit/);
  assert.deepEqual(app.requests, []);
  assert.equal((await app.commands()).filter(args => args[0] !== 'collab').length, 0);
});

test('missing lifecycle and registry cannot make a known live host appear absent or launch a duplicate', async t => {
  const app = await fixture();
  t.after(() => app.close());
  await app.runtime.ensure(app.session);
  await rm(app.lifecyclePath);
  await app.removeHost();
  await assert.rejects(app.runtime.stop(app.session), /does not support safe retirement/);
  await assert.rejects(app.runtime.ensure(app.session), /cannot safely start another process/);
  await assert.rejects(app.runtime.ensure({ ...app.session, id: 'another-topic' }), /OMP session limit/);
  assert.deepEqual(app.requests, []);
  assert.equal((await app.commands()).filter(args => args[0] !== 'collab').length, 0);
});

test('reservations serialize competing targets without spawning and share an existing logical slot', async t => {
  const app = await fixture();
  t.after(() => app.close());
  await app.removeHost();
  const results = await Promise.allSettled([app.runtime.reserveSession('first'),app.runtime.reserveSession('second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(results.filter(result => result.status === 'rejected').length,1);
  const winner = results.find(result => result.status === 'fulfilled')!;
  assert.equal(winner.status,'fulfilled');
  if (winner.status !== 'fulfilled') throw new Error('Missing reservation');
  const id = results[0]!.status === 'fulfilled' ? 'first' : 'second';
  const shared = await app.runtime.reserveSession(id);
  winner.value.release();
  await assert.rejects(app.runtime.reserveSession('competitor'), /OMP session limit/);
  shared.release();
  const next = await app.runtime.reserveSession();
  next.bind('final-target');
  await assert.rejects(app.runtime.ensure({...app.session,id:'competitor'}), /OMP session limit/);
  assert.equal((await app.commands()).filter(args => args[0] !== 'collab').length,0);
  next.release();
  const released = await app.runtime.reserveSession('competitor');
  released.release();
});

test('a reservation protects the managed slot from retirement and is invalidated by shutdown', async t => {
  const app = await fixture();
  t.after(() => app.close());
  const reservation = await app.runtime.reserveSession(app.session.id);
  assert.equal(await app.runtime.retireIdle(0),0);
  assert.deepEqual(app.requests,[]);
  await assert.rejects(app.runtime.reserveSession('competitor'), /OMP session limit/);
  await app.runtime.close();
  assert.throws(() => reservation.bind(app.session.id), /reservation expired/);
  await assert.rejects(app.runtime.reserveSession('competitor'), /stopping/);
  reservation.release();
});

test('denied admission authorization cannot retire another managed session', async t => {
  const app = await fixture();
  t.after(() => app.close());
  const denied = new Error('Admission permission revoked during discovery');
  await assert.rejects(app.runtime.ensure({...app.session,id:'another-topic'},async () => {
    throw denied;
  }),error => error === denied);
  await assert.rejects(app.runtime.reserveSession('another-topic',async () => {
    throw denied;
  }),error => error === denied);
  assert.deepEqual(app.requests,[]);
  assert.equal((await app.commands()).filter(args => args[0] !== 'collab').length,0);
});
