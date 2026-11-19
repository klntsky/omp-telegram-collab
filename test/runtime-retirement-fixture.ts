import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';
import { procIdentity } from '../src/runtime/process.js';

const execute = promisify(execFile);
type RetirementMode = 'busy' | 'uncertain' | 'accepted' | 'delayed' | 'never-received' | 'cancel-failure';
export interface RetirementRequest {
  type: 'retire'; requestId: string; sessionId: string; pid: number; deadline: number; guard: 'idle' | 'none';
}

export async function fixture(mode: RetirementMode = 'busy', pid = process.pid, guard: RetirementRequest['guard'] = 'idle') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-retirement-')));
  const fixtureProcess = pid === process.pid
    ? spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: directory, detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    : undefined;
  const fixtureExited = fixtureProcess ? once(fixtureProcess, 'exit') : undefined;
  if (fixtureProcess) {
    await once(fixtureProcess, 'spawn');
    assert.ok(fixtureProcess.pid);
    pid = fixtureProcess.pid;
  }
  const supervisor = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const supervisorExited = once(supervisor, 'exit');
  await once(supervisor, 'spawn');
  assert.ok(supervisor.pid);
  const supervisorIdentity = await procIdentity(supervisor.pid);
  assert.ok(supervisorIdentity);
  supervisor.kill();
  await supervisorExited;
  const dataDir = join(directory, 'data');
  const sessionDir = join(dataDir, 'sessions', 'topic');
  await mkdir(sessionDir, { recursive: true });
  const launchId = randomUUID();
  const launchDir = join(sessionDir, 'launches', launchId);
  await mkdir(launchDir, { recursive: true, mode: 0o700 });
  const identity = await procIdentity(pid);
  assert.ok(identity);
  await writeFile(join(sessionDir, 'active-launch.json'), JSON.stringify({
    version: 1, id: launchId, sessionId: 'fixture-session', cwd: directory,
    host: { pid, start: identity.start, instanceId: 'fixture-host' },
  }));
  await writeFile(join(launchDir, 'supervisor.json'), JSON.stringify({
    pid: supervisor.pid, start: supervisorIdentity.start, spawnFailed: true,
  }));
  const executable = join(directory, 'omp');
  const statePath = join(directory, 'registry.json');
  const startedPidPath = join(directory, 'started.pid');
  const commandsPath = join(directory, 'commands.jsonl');
  await writeFile(commandsPath, '');
  const socketPath = join(tmpdir(), `omp-tg-${randomUUID().replaceAll('-', '').slice(0, 24)}.sock`);
  const startupSocketPath = join(tmpdir(), `omp-tg-${randomUUID().replaceAll('-', '').slice(0, 24)}.sock`);
  const lifecyclePath = join(launchDir, 'lifecycle.json');
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
  const socketPath = ${JSON.stringify(startupSocketPath)};
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
      const grant = process.env.OMP_TELEGRAM_SESSION_DIR+'/retirement-'+request.requestId+'.request';
      fs.writeFileSync(grant, JSON.stringify(descriptor), {flag:'r+'});
      fs.renameSync(grant, process.env.OMP_TELEGRAM_SESSION_DIR+'/lifecycle.json');
      socket.end(JSON.stringify({requestId:request.requestId,sessionId:host.sessionId,pid:process.pid,outcome:'requested'})+'\\n');
      server.close(() => process.exit(0));
    });
  });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(${JSON.stringify(startedPidPath)}, String(process.pid));
    const publish = () => {
      fs.writeFileSync(process.env.OMP_TELEGRAM_SESSION_DIR+'/lifecycle.json', JSON.stringify(descriptor), {mode:0o600});
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
    pid, supervisorPid: supervisor.pid, sessionId: host.sessionId, socketPath, retiring: false, worktree: true, retirement: 1 };
  const persistLifecycle = () => writeFile(lifecyclePath, JSON.stringify(descriptor), { mode: 0o600 });
  await persistLifecycle();
  const requests: RetirementRequest[] = [];
  const delayed = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const startup = Promise.withResolvers<{ pid: number; supervisorPid: number }>();
  let startupControl: Socket | undefined;
  const handled: Promise<void>[] = [];
  const failures: unknown[] = [];
  const grantPath = (requestId: string) => join(launchDir, `retirement-${requestId}.request`);
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
    socket.on('error', error => {
      // These scenarios deliberately abandon the client while its request remains pending.
      if (['delayed', 'uncertain', 'never-received', 'cancel-failure'].includes(mode) && ['ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      failures.push(error);
    });
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
  await chmod(socketPath, 0o600);
  const config: AppConfig = { bots: [], instances: [{id: 1, defaultDir: directory, chats: []}],
    configPath: join(directory, 'config.yaml'), publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000, dataDir,
    omp: { executable, args: [], maxSessions: 1, startupTimeoutMs: 10000 } };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  const session: TopicSession = { id: 'topic', botId: 1, chatId: -100, threadId: 2,
    instanceId: 1, cwd: directory, name: 'Regression', status: 'open', createdAt: Date.now(), runtime: { kind: 'managed' } };
  return { runtime, config, session, host, requests, descriptor, persistLifecycle, sessionDir, lifecyclePath, grantPath, accept, received: received.promise,
    launchDir,
    async resetLaunch() { await rm(join(sessionDir, 'active-launch.json'), { force: true }); },
    async exitHost() {
      assert.ok(fixtureProcess);
      fixtureProcess.kill();
      await fixtureExited;
    },
    async commands() { return (await readFile(commandsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]); },
    async removeHost() { state.host = undefined; await persistRegistry(); },
    async rotateConnection() { host.generation++; await persistRegistry(); },
    waitForStartup() { return startup.promise; },
    async publishStartup() { assert.ok(startupControl); startupControl.end('publish\n'); },
    async release() { delayed.resolve(); await Promise.all(handled); assert.deepEqual(failures, []); },
    async grants() { return (await readdir(launchDir)).filter(name => /^retirement-.*\.request$/.test(name)); },
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
      descriptor.socketPath = join(tmpdir(), `omp-tg-${randomUUID().replaceAll('-', '').slice(0, 24)}.sock`);
      descriptor.retiring = false;
      const replacement = createServer(handleConnection);
      servers.push(replacement);
      const listening = Promise.withResolvers<void>();
      replacement.once('error', listening.reject);
      replacement.listen(descriptor.socketPath, listening.resolve);
      await listening.promise;
      await chmod(descriptor.socketPath, 0o600);
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
      await rm(startupSocketPath, { force: true });
      await rm(directory, { recursive: true, force: true });
      assert.deepEqual(failures, []);
    },
  };
}
