import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from './runtime-retirement-fixture.js';

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
