import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Descriptor { sessionId: string; pid: number; socketPath: string; retiring?: boolean; retirement: number }
interface Request { type: 'retire'; requestId: string; sessionId: string; pid: number; deadline: number; guard: 'idle' | 'none' }
interface Response { requestId: string; sessionId: string; pid: number; outcome?: 'requested' | 'busy' | 'expired'; error?: string }

async function fixture(options: { busy?: boolean; holdBeforeRename?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-host-retirement-'));
  const lifecyclePath = join(directory, 'lifecycle.json');
  const preparedPath = join(directory, 'prepared');
  const releasePath = join(directory, 'release');
  const extension = pathToFileURL(resolve('src/host-lifecycle.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import lifecycle from ${JSON.stringify(extension)};
    import {join} from 'node:path';
    import {setTimeout as delay} from 'node:timers/promises';
    const directory = process.env.OMP_TELEGRAM_SESSION_DIR;
    const release = ${JSON.stringify(releasePath)};
    const prepared = ${JSON.stringify(preparedPath)};
    const pause = () => {
      fs.writeFileSync(prepared, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(release)) {
        if (Date.now() >= deadline) throw new Error('Parent did not release host checkpoint');
        Atomics.wait(wait, 0, 0, 10);
      }
    };
    if (${Boolean(options.holdBeforeRename)}) {
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (/retirement-.*\\.request$/.test(String(source))) pause();
        return rename(source, destination);
      };
      syncBuiltinESMExports();
    }
    const handlers = new Map();
    const intervals = [];
    let shutdowns = 0;
    await lifecycle({on:(name, handler)=>handlers.set(name, handler)});
    await handlers.get('session_start')({}, {
      agent:{kind:'main'}, cwd:directory,
      sessionManager:{getSessionId:()=> 'protocol-session'},
      isIdle:()=> ${!options.busy}, hasPendingMessages:()=> false,
      setInterval:(callback, interval)=> {const timer=setInterval(callback,interval);intervals.push(timer);return timer;},
      shutdown:()=> {fs.writeFileSync(join(directory,'shutdowns'),String(++shutdowns));},
    });
    while (!fs.existsSync(join(directory,'lifecycle.json'))) await delay(5);
    process.send({ready:JSON.parse(fs.readFileSync(join(directory,'lifecycle.json'),'utf8'))});
    process.on('message', message => {
      if (message === 'pause') pause();
      if (message === 'stop') {
        for (const timer of intervals) clearInterval(timer);
        handlers.get('session_shutdown')();
        process.disconnect();
      }
    });
  `], { env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: directory, OMP_TELEGRAM_DEFAULT_PRESET: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  const ready = Promise.withResolvers<Descriptor>();
  child.once('message', message => {
    if (!message || typeof message !== 'object' || !('ready' in message)) {
      ready.reject(new Error('Lifecycle child did not send its descriptor'));
      return;
    }
    ready.resolve(message.ready as Descriptor);
  });
  child.once('error', ready.reject);
  child.once('exit', code => ready.reject(new Error(`Lifecycle child exited ${code}: ${output}`)));
  const descriptor = await ready.promise;
  async function waitForFile(filename: string): Promise<string> {
    const deadline = Date.now() + 10000;
    while (true) {
      try { return await readFile(filename, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Host did not publish ${filename}: ${output}`);
      await delay(10);
    }
  }
  const sockets = new Set<Socket>();
  const request = (value: Omit<Request, 'type'> & { type: 'retire' | 'list_skills' }, options: { loseAck?: boolean; sent?: () => void } = {}): Promise<Response | undefined> => {
    const response = Promise.withResolvers<Response | undefined>();
    const socket = createConnection(descriptor.socketPath);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(4000, () => { socket.destroy(); response.reject(new Error(`Host retirement response timed out: ${output}`)); });
    socket.once('error', response.reject);
    socket.once('connect', () => {
      socket.write(JSON.stringify(value) + '\n', () => {
        options.sent?.();
        if (options.loseAck) { socket.destroy(); response.resolve(undefined); }
      });
    });
    let input = '';
    socket.on('data', data => {
      input += data.toString();
      if (!input.includes('\n')) return;
      socket.destroy();
      try { response.resolve(JSON.parse(input.trim()) as Response); } catch (error) { response.reject(error); }
    });
    return response.promise;
  };
  return { directory, descriptor, lifecyclePath, preparedPath, releasePath, request, waitForFile,
    async prepare(guard: 'idle' | 'none' = 'idle'): Promise<{ value: Request; grant: string }> {
      const value: Request = { type: 'retire', requestId: randomUUID(), sessionId: descriptor.sessionId, pid: descriptor.pid, deadline: Date.now() + 2000, guard };
      const grant = join(directory, `retirement-${value.requestId}.request`);
      await writeFile(grant, '', { flag: 'wx', mode: 0o600 });
      return { value, grant };
    },
    async pause() { child.send('pause'); await waitForFile(preparedPath); },
    async assertNotRetiring() {
      assert.notEqual(JSON.parse(await readFile(lifecyclePath, 'utf8')).retiring, true);
      await assert.rejects(readFile(join(directory, 'shutdowns')), { code: 'ENOENT' });
    },
    async close() {
      await writeFile(releasePath, 'release');
      for (const socket of sockets) socket.destroy();
      if (child.connected) child.send('stop');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited.promise;
      clearTimeout(timeout);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('actual lifecycle host rejects busy idle retirement without consuming its grant', async t => {
  const app = await fixture({ busy: true });
  t.after(() => app.close());
  const { value, grant } = await app.prepare();
  assert.deepEqual(await app.request(value), { requestId: value.requestId, sessionId: app.descriptor.sessionId, pid: app.descriptor.pid, outcome: 'busy' });
  assert.equal(await readFile(grant, 'utf8'), '');
  await app.assertNotRetiring();
  const forced = await app.prepare('none');
  assert.equal((await app.request(forced.value))?.outcome, 'requested');
  assert.ok(Number(await app.waitForFile(join(app.directory, 'shutdowns'))) >= 1);
});

test('actual lifecycle host cannot accept a cancelled request buffered before host processing', async t => {
  const app = await fixture();
  t.after(() => app.close());
  const { value, grant } = await app.prepare();
  await app.pause();
  const sent = Promise.withResolvers<void>();
  const response = app.request(value, { sent: sent.resolve });
  await sent.promise;
  await unlink(grant);
  await writeFile(app.releasePath, 'release');
  assert.equal((await response)?.outcome, 'expired');
  await app.assertNotRetiring();
  await assert.rejects(readFile(grant), { code: 'ENOENT' });
});

test('actual lifecycle host cannot publish when cancellation wins between grant preparation and rename', async t => {
  const app = await fixture({ holdBeforeRename: true });
  t.after(() => app.close());
  const { value, grant } = await app.prepare();
  const before = await readFile(app.lifecyclePath, 'utf8');
  const response = app.request(value);
  await app.waitForFile(app.preparedPath);
  assert.equal(JSON.parse(await readFile(grant, 'utf8')).retiring, true);
  assert.equal(await readFile(app.lifecyclePath, 'utf8'), before, 'prepared descriptor must not replace live state before acceptance');
  await unlink(grant);
  await writeFile(app.releasePath, 'release');
  assert.equal((await response)?.outcome, 'expired');
  assert.equal(await readFile(app.lifecyclePath, 'utf8'), before);
  const availability = await app.request({ ...value, requestId: randomUUID(), type: 'list_skills', deadline: Date.now() + 2000 });
  assert.doesNotMatch(availability?.error ?? '', /host is retiring/);
  await app.assertNotRetiring();
  const fresh = await app.prepare();
  assert.equal((await app.request(fresh.value))?.outcome, 'requested', 'cancelled preparation must not mutate the in-memory descriptor');
});

test('actual lifecycle host publishes accepted retirement even when the acknowledgement is lost', async t => {
  const app = await fixture();
  t.after(() => app.close());
  const { value, grant } = await app.prepare();
  await app.request(value, { loseAck: true });
  await app.waitForFile(join(app.directory, 'shutdowns'));
  assert.equal(JSON.parse(await readFile(app.lifecyclePath, 'utf8')).retiring, true);
  await assert.rejects(readFile(grant), { code: 'ENOENT' });
});

test('actual lifecycle host rejects expired and mismatched retirement identities without accepting', async t => {
  const app = await fixture();
  t.after(() => app.close());
  for (const invalid of ['deadline', 'sessionId', 'pid', 'requestId'] as const) {
    const { value, grant } = await app.prepare();
    if (invalid === 'deadline') value.deadline = Date.now() - 1;
    else if (invalid === 'sessionId') value.sessionId = 'another-session';
    else if (invalid === 'pid') value.pid++;
    else value.requestId = '../outside';
    const response = await app.request(value);
    assert.ok(response?.outcome === 'expired' || typeof response?.error === 'string');
    assert.equal(await readFile(grant, 'utf8'), '');
    await app.assertNotRetiring();
  }
});
