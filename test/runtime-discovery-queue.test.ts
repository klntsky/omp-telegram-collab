import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { AppConfig } from '../shared/contracts.js';
import { createDiscovery, DiscoveryTimeoutError } from '../src/runtime/discovery.js';
import { createRegistry } from '../src/runtime/registry.js';

interface Start {
  pid: number;
  args: string[];
  at: number;
}
interface Response {
  value?: Record<string, unknown>;
  stderr?: string;
  code?: number;
}

// These tests exercise real execFile timeout/exit behavior; a fake parent clock
// cannot advance the separate executable or the operating system's process exit.
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-discovery-queue-'));
  const executable = join(directory, 'omp');
  const startsPath = join(directory, 'starts.jsonl');
  await writeFile(startsPath, '');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const directory = ${JSON.stringify(directory)};
const startsPath = path.join(directory, 'starts.jsonl');
const previous = fs.readFileSync(startsPath, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
const last = previous.at(-1);
if (last) {
  try { process.kill(last.pid, 0); fs.writeFileSync(path.join(directory, 'overlap'), 'overlap'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const probe = previous.length + 1;
fs.appendFileSync(startsPath, JSON.stringify({pid: process.pid, args: process.argv.slice(2), at: Date.now()}) + '\\n');
const releasePath = path.join(directory, 'release-' + probe);
const timer = setInterval(() => {
  const stopped = fs.existsSync(path.join(directory, 'stop'));
  if (!stopped && !fs.existsSync(releasePath)) return;
  clearInterval(timer);
  const response = stopped ? {} : JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  if (response.stderr) process.stderr.write(response.stderr);
  if (!response.code) console.log(JSON.stringify(response.value ?? {version: 1, hosts: [], probe}));
  process.exitCode = response.code ?? 0;
}, 5);
`);
  await chmod(executable, 0o700);
  const config: AppConfig = {
    bots: [], instances: [], configPath: join(directory, 'unused.yaml'),
    publicUrl: '', host: '127.0.0.1', port: 3000, dataDir: directory,
    omp: { executable, args: [], maxSessions: 1, startupTimeoutMs: 15000 },
  };
  const owner = createDiscovery(config);
  const pending: Promise<unknown>[] = [];
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    // Cleanup owns unsettled operations even if a test assertion fails early.
    void promise.catch(() => undefined);
    return promise;
  }
  async function starts(): Promise<Start[]> {
    return (await readFile(startsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Start);
  }
  async function started(count: number): Promise<Start> {
    const deadline = Date.now() + config.omp.startupTimeoutMs;
    while (Date.now() < deadline) {
      t.signal.throwIfAborted();
      const values = await starts();
      if (values.length >= count) {
        assert.equal(values.length, count);
        return values[count - 1]!;
      }
      await delay(5, undefined, { signal: t.signal });
    }
    assert.fail(`Discovery subprocess ${count} did not start`);
  }
  t.after(async () => {
    await writeFile(join(directory, 'stop'), '');
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === 'rejected') console.error('Discovery test cleanup observed rejection', result.reason);
    }
    try {
      await assert.rejects(readFile(join(directory, 'overlap')), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    config, directory, executable, starts, started, track,
    list: (deadline = Date.now() + 15000) => track(owner.list(deadline)),
    link: (id: string, deadline = Date.now() + 15000) => track(owner.link(id, deadline)),
    release: (probe: number, response: Response = {}) => writeFile(join(directory, `release-${probe}`), JSON.stringify(response)),
  };
}

test('discovery serializes list and distinct links, batching only queued lists', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const first = app.list();
  await app.started(1);
  const requested = Date.now();
  const queued = Array.from({ length: 40 }, () => app.list());
  const links = [app.link('one'), app.link('two')];
  const following = [app.list(), app.list()];
  assert.equal((await app.starts()).length, 1);
  await app.release(1);
  assert.equal((await first).probe, 1);
  assert.ok((await app.started(2)).at >= requested);
  await app.release(2);
  const snapshots = await Promise.all(queued);
  assert.ok(snapshots.every(value => value.probe === 2 && value === snapshots[0]));
  for (const [index, id] of ['one', 'two'].entries()) {
    assert.deepEqual((await app.started(index + 3)).args, ['collab', 'link', id, '--json']);
    await app.release(index + 3);
    await links[index];
  }
  await app.started(5);
  await app.release(5);
  assert.deepEqual((await Promise.all(following)).map(value => value.probe), [5, 5]);
  const fresh = app.list();
  await app.started(6);
  await app.release(6);
  assert.equal((await fresh).probe, 6);
});

test('post-link registry identity checks cannot reuse an already-running list', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const registry = createRegistry({ config: app.config, assertActive() {}, closed: false, async acquire() {} });
  const host = { instanceId: 'fixture', sessionId: 'session', generation: 1, pid: process.pid,
    cwd: app.directory, access: 'control' as const, relayConnected: true };
  const binding = app.track(registry.resolve(host, Date.now() + 10000));
  const rejected = assert.rejects(binding, /OMP host session changed while resolving its capability/);
  await app.started(1);
  const beforeLinkFinished = app.track(registry.list(Date.now() + 10000));
  await app.release(1, { value: { version: 1, instanceId: host.instanceId, generation: 1, access: 'control',
    url: `wss://localhost/r/fixture-room.${Buffer.alloc(48, 1).toString('base64url')}` } });
  await app.started(2);
  await app.release(2, { value: { version: 1, hosts: [host] } });
  assert.deepEqual(await beforeLinkFinished, [host]);
  await app.started(3);
  await app.release(3, { value: { version: 1, hosts: [{ ...host, generation: 2 }] } });
  await rejected;
});

test('expired queued requests never launch, and an expired batch member cannot cancel live callers', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const first = app.list();
  await app.started(1);
  await assert.rejects(app.list(Date.now() - 1), /OMP discovery timed out/);
  const expired = assert.rejects(app.link('expired', Date.now() + 80), /OMP discovery timed out/);
  const expiredList = assert.rejects(app.list(Date.now() + 80), /OMP discovery timed out/);
  await Promise.all([expired, expiredList]);
  assert.equal((await app.starts()).length, 1);
  const early = app.list(Date.now() + 500);
  const earlyRejected = assert.rejects(early, /OMP discovery timed out/);
  const live = app.list();
  await app.release(1);
  await first;
  await app.started(2);
  await earlyRejected;
  assert.equal((await app.starts()).length, 2);
  await app.release(2);
  assert.equal((await live).probe, 2);
  assert.equal((await app.starts()).length, 2);
});

test('pending discovery storage is capped and expired callers release admission', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const first = app.list();
  await app.started(1);
  const queued = Array.from({ length: 127 }, () => assert.rejects(app.list(Date.now() + 500), /OMP discovery timed out/));
  await assert.rejects(app.link('overflow'), /OMP discovery queue is full/);
  await Promise.all(queued);
  const next = app.link('admitted');
  await app.release(1);
  await first;
  assert.deepEqual((await app.started(2)).args, ['collab', 'link', 'admitted', '--json']);
  await app.release(2);
  await next;
});

test('discovery allows probes beyond five seconds within the operation deadline', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const result = app.list(Date.now() + 10000);
  await app.started(1);
  await delay(5200);
  await app.release(1);
  assert.equal((await result).probe, 1);
});

test('active deadline retains the original execFile SIGKILL error and logs it once', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const started = Date.now();
  const result = app.list(started + 500);
  await assert.rejects(result, error => {
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, 'code'), null);
    assert.equal(Reflect.get(error, 'signal'), 'SIGKILL');
    assert.equal(Reflect.get(error, 'killed'), true);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]![2], error);
    assert.deepEqual(logged[0]![1], { executable: app.executable, args: ['collab', 'list', '--json'], cwd: app.directory });
    return true;
  });
  assert.ok(Date.now() - started >= 450);
});

test('batched failures retain original diagnostics and identity without caching failures', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const first = app.list();
  await app.started(1);
  const failed = [app.list(), app.list()];
  const settled = Promise.allSettled(failed);
  await app.release(1);
  await first;
  await app.started(2);
  const stderr = 'Registry unavailable: <socket> & permission denied\nOriginal diagnostic line two\n';
  await app.release(2, { stderr, code: 23 });
  const outcomes = await settled;
  assert.equal(outcomes[0]!.status, 'rejected');
  assert.equal(outcomes[1]!.status, 'rejected');
  if (outcomes[0]!.status !== 'rejected' || outcomes[1]!.status !== 'rejected') assert.fail('Expected both callers to fail');
  const error: unknown = outcomes[0]!.reason;
  assert.ok(error instanceof Error);
  assert.equal(error, outcomes[1]!.reason);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]![2], error);
  assert.equal(Reflect.get(error, 'code'), 23);
  assert.equal(Reflect.get(error, 'signal'), null);
  assert.equal(Reflect.get(error, 'killed'), false);
  assert.equal(error.message, `Command failed: ${app.executable} collab list --json\n${stderr}`);
  const fresh = app.list();
  await app.started(3);
  await app.release(3);
  assert.equal((await fresh).probe, 3);
});

test('missing executable rejection retains native execFile fields', async t => {
  const app = await fixture(t);
  await rm(app.executable);
  const original = await promisify(execFile)(app.executable, ['collab', 'list', '--json'], { cwd: app.directory }).catch((error: unknown) => error);
  assert.ok(original instanceof Error);
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  await assert.rejects(app.list(), error => {
    assert.ok(error instanceof Error);
    for (const field of ['message', 'code', 'errno', 'syscall', 'path', 'spawnargs']) {
      assert.deepEqual(Reflect.get(error, field), Reflect.get(original, field));
    }
    assert.equal(logged.length, 1);
    assert.equal(logged[0]![2], error);
    return true;
  });
});

for (const initial of ['link', 'omission'] as const) {
  for (const final of ['deadline', 'fatal'] as const) {
    test(`registry preserves ${initial} diagnostic only for final ${final}`, async t => {
      if (process.platform !== 'linux') return t.skip('Requires Linux process lifetime identity');
      const app = await fixture(t);
      const logged: unknown[][] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
      const registry = createRegistry({ config: app.config, assertActive() {}, closed: false, async acquire() {} });
      const host = { instanceId: 'fixture', sessionId: 'session', generation: 1, pid: process.pid,
        cwd: app.directory, access: 'control' as const, relayConnected: true };
      const deadline = Date.now() + 10000;
      const result = app.track(registry.resolve(host, deadline));
      const observed = result.catch(error => error as unknown);
      await app.started(1);
      await app.release(1, initial === 'link'
        ? { code: 1, stderr: 'error: no active Collab host matches fixture\n' }
        : { value: { version: 1, instanceId: host.instanceId, generation: 1, access: 'control',
          url: `wss://localhost/r/fixture-room.${Buffer.alloc(48, 1).toString('base64url')}` } });
      await app.started(2);
      await app.release(2, { value: { version: 1, hosts: initial === 'link' ? [host] : [] } });
      await app.started(3);
      const clock = t.mock.method(Date, 'now', () => deadline + 1);
      await app.release(3, final === 'fatal' ? { code: 23, stderr: 'permission denied\n' } : {});
      const error = await observed;
      clock.mock.restore();
      assert.ok(error instanceof Error);
      if (final === 'fatal') {
        assert.equal(error, logged.at(-1)![2]);
        assert.equal(Reflect.get(error, 'code'), 23);
      } else {
        assert.ok(error.cause instanceof DiscoveryTimeoutError);
        if (initial === 'link') assert.equal(error, logged[0]![2]);
        else assert.match(error.message, /OMP host session changed while resolving its capability/);
      }
    });
  }
}
