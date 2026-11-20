import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { OmpRuntime } from '../src/runtime.js';
import { fixture, type RetirementRequest } from './runtime-retirement-fixture.js';
import { createRetirement } from '../src/runtime/retirement.js';
import { procIdentity } from '../src/runtime/process.js';
import type { ManagedHost } from '../src/runtime/types.js';

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
  const app = await fixture('cancel-failure');
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
  await app.stopProcess();
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
      const retiringPid = app.host.pid;
      await app.replaceHost('new');
      assert.notEqual(app.host.pid, retiringPid);
      const replacement = await app.runtime.ensure(app.session);
      assert.equal(replacement.instanceId, 'replacement-host');
      assert.doesNotThrow(() => app.runtime.markPrompt(app.session.id));
      const release = app.runtime.retain(app.session.id);
      release();
    }
  });
}

for (const prior of [false, true]) {
  test(`worktree waits for ${prior ? 'previously accepted' : 'slow accepted'} retirement to complete`, async t => {
    const app = await fixture('accepted');
    t.after(() => { t.mock.restoreAll(); t.mock.timers.reset(); return app.close(); });
    const host: ManagedHost = { sessionId: app.host.sessionId, exited: false, retiring: prior };
    if (prior) {
      const identity = await procIdentity(app.host.pid);
      assert.ok(identity);
      host.identity = { pid: app.host.pid, start: identity.start };
      host.retirement = { ...host.identity, socketPath: app.descriptor.socketPath };
      app.descriptor.retiring = true;
      await app.persistLifecycle();
    }
    const managed = new Map([[app.session.id, host]]);
    const retirement = createRetirement({
      config: app.config, managed, killing: new Map(), forgetActivity() {},
      async lifecycle() { return app.descriptor; },
      async list() { return [app.host]; },
    });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    let poll = Promise.withResolvers<void>();
    const setTimer = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = setTimer(callback, ms, ...args);
      if (ms === 100) poll.resolve();
      return timer;
    });
    const pending = retirement.shutdown(app.session.id, host, 'worktree');
    await Promise.race([poll.promise, pending.then(() => { throw new Error('Retirement returned before observing exit'); })]);
    poll = Promise.withResolvers<void>();
    t.mock.timers.tick(8000);
    await Promise.race([poll.promise, pending.then(() => { throw new Error('Retirement returned before configured completion deadline'); })]);
    await app.stopProcess();
    t.mock.timers.tick(100);
    await pending;
    t.mock.restoreAll();
    t.mock.timers.reset();
    assert.equal(host.exited, true);
    assert.equal(managed.has(app.session.id), false);
    assert.equal(app.requests.length, prior ? 0 : 1);
  });
}

test('worktree refuses a closed session while its accepted retirement is pending', async t => {
  const app = await fixture('accepted');
  t.after(() => app.close());
  app.descriptor.retiring = true;
  await app.persistLifecycle();
  await assert.rejects(app.runtime.ensure(app.session), /Session is retiring/);
  await assert.rejects(app.runtime.worktree({ ...app.session, status: 'closed' }), { message: 'Session closed' });
  assert.equal(app.descriptor.retiring, true);
  assert.deepEqual(app.requests, []);
  assert.ok((await app.commands()).every(args => args[0] === 'collab' && ['list', 'link'].includes(args[1]!)));
});

test('worktree retirement timeout preserves the accepted host fence and diagnostic', async t => {
  const app = await fixture('accepted');
  t.after(() => { t.mock.restoreAll(); t.mock.timers.reset(); return app.close(); });
  app.config.omp.startupTimeoutMs = 200;
  const host: ManagedHost = { sessionId: app.host.sessionId, exited: false, retiring: false };
  const managed = new Map([[app.session.id, host]]);
  const retirement = createRetirement({
    config: app.config, managed, killing: new Map(), forgetActivity() {},
    async lifecycle() { return app.descriptor; },
    async list() { return [app.host]; },
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const poll = Promise.withResolvers<void>();
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = setTimer(callback, ms, ...args);
    if (ms === 100) poll.resolve();
    return timer;
  });
  const rejected = assert.rejects(retirement.shutdown(app.session.id, host, 'worktree'), /retirement has not completed within 200ms/);
  await poll.promise;
  t.mock.timers.tick(200);
  await rejected;
  t.mock.restoreAll();
  t.mock.timers.reset();
  assert.equal(host.exited, false);
  assert.equal(host.retiring, true);
  assert.ok(host.retirement);
  assert.equal(managed.get(app.session.id), host);
  assert.equal(app.requests.length, 1);
});

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

