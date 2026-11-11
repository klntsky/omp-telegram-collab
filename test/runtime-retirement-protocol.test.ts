import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { OmpRuntime } from '../src/runtime.js';
import { fixture, type RetirementRequest } from './runtime-retirement-fixture.js';

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

