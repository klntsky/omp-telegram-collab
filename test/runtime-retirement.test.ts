import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TopicSession } from '../shared/contracts.js';
import { fixture } from './runtime-retirement-fixture.js';

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
        type: 'session', version: 3, id: 'another-history', cwd: app.session.cwd,
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

