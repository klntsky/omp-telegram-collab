import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

const execute = promisify(execFile);
type RetirementMode = 'busy' | 'uncertain' | 'accepted';

async function fixture(mode: RetirementMode = 'busy') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-retirement-')));
  const dataDir = join(directory, 'data');
  const sessionDir = join(dataDir, 'sessions', 'topic');
  await mkdir(sessionDir, { recursive: true });
  const executable = join(directory, 'omp');
  const statePath = join(directory, 'registry.json');
  const socketPath = join(directory, 'host.sock');
  const lifecyclePath = join(sessionDir, 'lifecycle.json');
  const host = { instanceId: 'fixture-host', sessionId: 'fixture-session', generation: 7,
    pid: process.pid, cwd: directory, access: 'control', relayConnected: true, busy: false };
  const url = `wss://localhost/r/fixture-room.${Buffer.alloc(48, 1).toString('base64url')}`;
  const state = { host, failLink: false };
  const persistRegistry = () => writeFile(statePath, JSON.stringify(state));
  await persistRegistry();
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconst state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));\nif (process.argv[3] === 'link') {\n if (state.failLink) { process.stderr.write('Original reconnect registry failure\\n'); process.exit(23); }\n console.log(JSON.stringify({version:1,instanceId:state.host.instanceId,generation:state.host.generation,access:'control',url:${JSON.stringify(url)}}));\n} else console.log(JSON.stringify({version:1,hosts:[state.host]}));\n`);
  await chmod(executable, 0o700);
  const history = join(sessionDir, 'history.jsonl');
  await writeFile(history, JSON.stringify({ type: 'session', version: 3, id: host.sessionId, cwd: directory }) + '\n');
  await writeFile(join(sessionDir, 'binding.json'), JSON.stringify({ version: 1, sessionId: host.sessionId, sessionFile: history, cwd: directory }));
  const descriptor = { pid: process.pid, supervisorPid: process.ppid, sessionId: host.sessionId,
    socketPath, retiring: false, worktree: true, retireIdle: true };
  const persistLifecycle = () => writeFile(lifecyclePath, JSON.stringify(descriptor));
  await persistLifecycle();
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', data => {
      const request = data.toString().trim();
      requests.push(request);
      if (request === 'retire-idle' && mode === 'busy') { socket.end('busy\n'); return; }
      descriptor.retiring = true;
      void persistLifecycle().then(() => {
        if (mode === 'uncertain') return;
        else if (mode === 'busy') socket.end('busy\n');
        else socket.end('requested\n');
      });
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  const config: AppConfig = { bots: [], instances: { [directory]: { admins: [], chats: [] } },
    configPath: join(directory, 'config.yaml'), publicUrl: 'https://localhost:3000',
    host: '127.0.0.1', port: 3000, dataDir,
    omp: { executable, args: [], maxSessions: 1, startupTimeoutMs: 10000 } };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  const session: TopicSession = { id: 'topic', botId: 1, chatId: -100, threadId: 2,
    instancePath: directory, name: 'Regression', status: 'open', createdAt: Date.now(), runtime: { kind: 'managed' } };
  return { runtime, session, host, requests, descriptor, persistLifecycle,
    async failLink(value: boolean) { state.failLink = value; await persistRegistry(); },
    async originalError() {
      try { await execute(executable, ['collab', 'link', host.instanceId, '--json'], { cwd: dataDir }); }
      catch (error) { return error as Error & { code: number; signal: string | null }; }
      throw new Error('Expected registry failure');
    },
    async close() {
      await writeFile(statePath, JSON.stringify({ ...state, host: undefined }));
      await rm(lifecyclePath, { force: true });
      await runtime.close();
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await rm(directory, { recursive: true, force: true });
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
  assert.deepEqual(await app.runtime.ensure(app.session), initial);
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
});

test('automatic idle retirement leaves unsupported hosts available without unconditional fallback', async t => {
  const app = await fixture('busy');
  t.after(() => app.close());
  app.descriptor.retireIdle = false;
  await app.persistLifecycle();
  const initial = await app.runtime.ensure(app.session);
  assert.equal(await app.runtime.retireIdle(0), 0);
  assert.deepEqual(app.requests, []);
  assert.equal(app.descriptor.retiring, false);
  assert.deepEqual(await app.runtime.ensure(app.session), initial);
  assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
});

for (const mode of ['uncertain', 'accepted'] as const) {
  test(`${mode} retirement acknowledgement keeps a still-running retiring host blocked`, async t => {
    const app = await fixture(mode);
    t.after(() => app.close());
    await app.runtime.ensure(app.session);
    assert.equal(await app.runtime.retireIdle(0), 0);
    assert.equal(app.descriptor.retiring, true);
    assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
    assert.throws(() => app.runtime.retain(app.session.id), /Session is retiring/);
    await app.runtime.ensure(app.session);
    assert.throws(() => app.runtime.markPrompt(app.session.id), /Session is retiring/);
    assert.equal(await app.runtime.retireIdle(0), 0);
    assert.equal(app.requests.length, 1, 'accepted retirement must not be requested again');
    if (mode === 'accepted') {
      app.host.pid = process.ppid;
      app.host.instanceId = 'replacement-host';
      app.host.generation++;
      app.descriptor.pid = app.host.pid;
      app.descriptor.retiring = false;
      await app.persistLifecycle();
      await app.failLink(false);
      const replacement = await app.runtime.ensure(app.session);
      assert.equal(replacement.instanceId, 'replacement-host');
      assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
      const release = app.runtime.retain(app.session.id);
      release();
    }
  });
}
