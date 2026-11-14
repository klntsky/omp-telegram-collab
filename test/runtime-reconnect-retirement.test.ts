import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from './runtime-retirement-fixture.js';

test('passive reconnect refreshes room identity so retirement can release capacity', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await once(child, 'spawn');
  assert.ok(child.pid);
  const app = await fixture('accepted', child.pid);
  t.after(() => app.close());
  const initial = await app.runtime.ensure(app.session);
  await app.rotateConnection();
  const reconnected = await app.runtime.resolveExisting(app.session);
  assert.equal(reconnected?.instanceId, initial.instanceId);
  assert.equal(reconnected?.generation, initial.generation + 1);
  assert.equal(await app.runtime.retireIdle(0), 0);
  assert.equal(app.descriptor.retiring, true);
  assert.equal(app.requests[0]?.pid, child.pid);
  assert.equal(app.requests[0]?.guard, 'idle');
  child.kill();
  await exited;
  await app.removeHost();
  await rm(app.lifecyclePath);
  assert.equal(await app.runtime.retireIdle(0), 1);
  const reservation = await app.runtime.reserveSession('new-topic');
  reservation.release();
});

for (const replacement of ['instance', 'process'] as const) {
  test(`passive reconnect cannot authorize retirement of a replacement ${replacement}`, { timeout: 10000 }, async t => {
    const app = await fixture('accepted');
    t.after(() => app.close());
    const initial = await app.runtime.ensure(app.session);
    if (replacement === 'instance') await app.replaceHost();
    else {
      app.host.pid = process.ppid;
      app.descriptor.pid = process.ppid;
      await app.persistLifecycle();
      await app.rotateConnection();
    }
    const reconnected = await app.runtime.resolveExisting(app.session);
    assert.equal(reconnected?.generation, initial.generation + 1);
    await assert.rejects(app.runtime.retireIdle(0), { message: 'Managed OMP host identity changed' });
    assert.equal(app.descriptor.retiring, false);
    assert.deepEqual(app.requests, []);
  });
}
