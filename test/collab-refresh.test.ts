import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLLAB_PROTO, WRITE_TOKEN_BYTES, type HostFrame } from '@oh-my-pi/pi-wire';
import { connectCollab } from '../src/collab.js';
import { encodeBase64Url } from '../src/vendor/link.js';
import { hostFrames, state, welcome, emptySnapshot, historyEntry, liveConnection } from './collab-fixture.js';

test('requested refresh repeats authenticated hello on the same socket and isolates only snapshot frames', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  const first = historyEntry('first');
  const second = historyEntry('second');
  const refreshed: HostFrame[] = [];
  const refreshing = app.connection.refreshSnapshot(frame => refreshed.push(frame));
  assert.deepEqual(await app.host.nextGuest(), app.hello);
  assert.deepEqual(app.hello, {t: 'hello', proto: COLLAB_PROTO, name: 'Guest', writeToken: encodeBase64Url(new Uint8Array(WRITE_TOKEN_BYTES))});
  const liveBefore: HostFrame = {t: 'state', state: {...state, isStreaming: true}};
  const liveDuring: HostFrame = {t: 'event', event: {type: 'agent_start'}};
  const liveAfter: HostFrame = {t: 'entry', entry: historyEntry('live')};
  const snapshot: HostFrame[] = [
    {...welcome, entryCount: 2},
    {t: 'snapshot-chunk', entries: [first], final: false},
    {t: 'snapshot-chunk', entries: [second], final: true},
  ];
  await app.host.send([liveBefore, snapshot[0]!, snapshot[1]!, liveDuring, snapshot[2]!, liveAfter]);
  await refreshing;
  await app.waitFor(frame => frame.t === 'entry');
  assert.deepEqual(refreshed, snapshot);
  assert.deepEqual(app.received, [welcome, emptySnapshot, liveBefore, liveDuring, liveAfter]);
  assert.deepEqual(app.closeReasons, []);
  assert.equal(app.host.connectionCount, 1);
  app.connection.send({t: 'abort'});
  assert.deepEqual(await app.host.nextGuest(), {t: 'abort'});
  const again = app.connection.refreshSnapshot(() => {});
  assert.deepEqual(await app.host.nextGuest(), app.hello);
  await app.host.send([welcome, emptySnapshot]);
  await again;
});

for (const frame of [welcome, emptySnapshot]) {
  test(`unsolicited second ${frame.t} closes the connection`, {timeout: 5000}, async t => {
    const app = await liveConnection(t);
    await app.host.send([frame]);
    assert.match(await app.closed, /Unexpected Collab snapshot/);
    assert.deepEqual(app.received, [welcome, emptySnapshot]);
  });
}

for (const [label, frames, reason] of [
  ['wrong session', [{...welcome, header: {...welcome.header, id: 'other'}}], /identity mismatch/],
  ['wrong protocol', [{...welcome, proto: COLLAB_PROTO + 1}], /identity mismatch/],
  ['refused control', [{...welcome, readOnly: true}], /refused control access/],
  ['invalid entry count', [{...welcome, entryCount: -1}], /Invalid Collab snapshot/],
  ['fractional entry count', [{...welcome, entryCount: 0.5}], /Invalid Collab snapshot/],
  ['chunk before welcome', [emptySnapshot], /snapshot arrived before welcome/],
  ['missing final flag', [welcome, {t: 'snapshot-chunk', entries: []} as unknown as HostFrame], /Invalid Collab snapshot chunk/],
  ['missing entries', [welcome, {t: 'snapshot-chunk', final: true} as unknown as HostFrame], /Invalid Collab snapshot chunk/],
  ['too few entries', [{...welcome, entryCount: 1}, emptySnapshot], /snapshot count mismatch/],
  ['too many entries', [welcome, {t: 'snapshot-chunk', entries: [historyEntry('excess')], final: false}], /snapshot count mismatch/],
  ['duplicate welcome', [welcome, welcome], /identity mismatch/],
] satisfies [string, HostFrame[], RegExp][]) {
  test(`requested refresh rejects ${label}`, {timeout: 5000}, async t => {
    const app = await liveConnection(t);
    const refreshing = app.connection.refreshSnapshot(() => {});
    const rejected = assert.rejects(refreshing, reason);
    assert.equal((await app.host.nextGuest()).t, 'hello');
    await app.host.send(frames);
    await rejected;
    assert.match(await app.closed, reason);
    assert.deepEqual(app.received, [welcome, emptySnapshot]);
  });
}

test('concurrent snapshot refresh rejects without sending another hello or disturbing the first request', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  const frames: HostFrame[] = [];
  const refreshing = app.connection.refreshSnapshot(frame => frames.push(frame));
  await assert.rejects(app.connection.refreshSnapshot(() => assert.fail('Concurrent callback ran')), /already in progress/);
  assert.equal((await app.host.nextGuest()).t, 'hello');
  await app.host.send([welcome, emptySnapshot]);
  await refreshing;
  app.connection.send({t: 'abort'});
  assert.deepEqual(await app.host.nextGuest(), {t: 'abort'});
  assert.deepEqual(frames, [welcome, emptySnapshot]);
  assert.deepEqual(app.closeReasons, []);
});

test('a recognized history-only hello refusal never reaches instruction handling', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  const rejection: HostFrame = {t: 'error', message: 'Session transition in progress; join again when it completes'};
  const refreshing = app.connection.refreshSnapshot(() => assert.fail('Rejected refresh callback ran'));
  const rejected = assert.rejects(refreshing, {message: rejection.message});
  await app.host.nextGuest();
  await app.host.send([rejection]);
  await rejected;
  assert.deepEqual(app.closeReasons, []);
  assert.deepEqual(app.received, [welcome, emptySnapshot]);
  const retry = app.connection.refreshSnapshot(() => {});
  await app.host.nextGuest();
  await app.host.send([welcome, emptySnapshot]);
  await retry;
  await app.flush();
  assert.equal(app.host.connectionCount, 1);
});

for (const failureAt of ['welcome', 'snapshot-chunk'] as const) {
  test(`refresh callback failure at ${failureAt} preserves the error and drains to final`, {timeout: 5000}, async t => {
    const app = await liveConnection(t);
    const diagnostic = new Error('Original index failure\nStorage diagnostic');
    const callbacks: HostFrame[] = [];
    const refreshing = app.connection.refreshSnapshot(frame => {
      callbacks.push(frame);
      if (frame.t === failureAt) throw diagnostic;
    });
    const rejected = assert.rejects(refreshing, error => error === diagnostic);
    await app.host.nextGuest();
    await app.host.send([welcome, {t: 'snapshot-chunk', entries: [], final: false}]);
    await rejected;
    await assert.rejects(app.connection.refreshSnapshot(() => {}), /already in progress/);
    await app.host.send([emptySnapshot]);
    await app.flush();
    assert.deepEqual(callbacks.map(frame => frame.t), failureAt === 'welcome' ? ['welcome'] : ['welcome', 'snapshot-chunk']);
    assert.ok(app.received.slice(2).every(frame => frame.t !== 'welcome' && frame.t !== 'snapshot-chunk'));
    assert.deepEqual(app.closeReasons, []);
    const retry = app.connection.refreshSnapshot(() => {});
    await app.host.nextGuest();
    await app.host.send([welcome, emptySnapshot]);
    await retry;
  });
}

for (const welcomed of [false, true]) {
  test(`refresh timeout ${welcomed ? 'after' : 'before'} welcome fences late completion`, {timeout: 5000}, async t => {
    const app = await liveConnection(t);
    t.mock.timers.enable({apis: ['setTimeout']});
    const callbacks: HostFrame[] = [];
    const refreshing = app.connection.refreshSnapshot(frame => callbacks.push(frame));
    const rejected = assert.rejects(refreshing, /Collab snapshot refresh timed out/);
    await app.host.nextGuest();
    if (welcomed) {
      await app.host.send([welcome]);
      await app.flush();
    }
    t.mock.timers.tick(60_000);
    await rejected;
    await assert.rejects(app.connection.refreshSnapshot(() => {}), /already in progress/);
    await app.host.send(welcomed ? [emptySnapshot] : [welcome, emptySnapshot]);
    await app.flush();
    assert.deepEqual(callbacks, welcomed ? [welcome] : []);
    assert.ok(app.received.slice(2).every(frame => frame.t !== 'welcome' && frame.t !== 'snapshot-chunk'));
    assert.deepEqual(app.closeReasons, []);
    const retry = app.connection.refreshSnapshot(() => {});
    await app.host.nextGuest();
    await app.host.send([welcome, emptySnapshot]);
    await retry;
  });
}

test('close rejects a waiting refresh, releases its timer, and rejects later refresh calls', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  const refreshing = app.connection.refreshSnapshot(() => assert.fail('Closed refresh callback ran'));
  const rejected = assert.rejects(refreshing, {message: 'closed'});
  await app.host.nextGuest();
  app.connection.close();
  await rejected;
  t.mock.timers.tick(120_000);
  assert.deepEqual(app.closeReasons, ['closed']);
  await assert.rejects(app.connection.refreshSnapshot(() => {}), /connection is closed/);
});

test('transport close rejects the waiting refresh with its connection diagnostic', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  const refreshing = app.connection.refreshSnapshot(() => {});
  const rejected = assert.rejects(refreshing, /Collab connection closed/);
  await app.host.nextGuest();
  const [socket] = await app.host.connected;
  socket.close(1000);
  await rejected;
  assert.equal(await app.closed, 'Collab connection closed (1000)');
});

test('public send cannot send arbitrary native hello frames', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  assert.throws(() => app.connection.send(app.hello), /Unsupported guest frame/);
  app.connection.send({t: 'abort'});
  assert.deepEqual(await app.host.nextGuest(), {t: 'abort'});
  assert.deepEqual(app.closeReasons, []);
});

test('an unrelated prompt error before refresh welcome cannot release its snapshot fence', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  const callbacks: HostFrame[] = [];
  const refreshing = app.connection.refreshSnapshot(frame => callbacks.push(frame));
  await app.host.nextGuest();
  const diagnostic: HostFrame = {t: 'error', message: 'prompt failed: Original model diagnostic\nProvider detail'};
  await app.host.send([diagnostic]);
  await app.waitFor(frame => frame === diagnostic || (frame.t === 'error' && frame.message === diagnostic.message));
  await assert.rejects(app.connection.refreshSnapshot(() => {}), /already in progress/);
  await app.host.send([welcome, emptySnapshot]);
  await refreshing;
  assert.deepEqual(callbacks, [welcome, emptySnapshot]);
  assert.deepEqual(app.received, [welcome, emptySnapshot, diagnostic]);
  assert.deepEqual(app.closeReasons, []);
  const next = app.connection.refreshSnapshot(() => {});
  await app.host.nextGuest();
  await app.host.send([welcome, emptySnapshot]);
  await next;
});

test('a late host error cannot release the drain fence after a pre-welcome timeout', {timeout: 5000}, async t => {
  const app = await liveConnection(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  const refreshing = app.connection.refreshSnapshot(() => assert.fail('Timed out refresh callback ran'));
  const rejected = assert.rejects(refreshing, /snapshot refresh timed out/);
  await app.host.nextGuest();
  t.mock.timers.tick(60_000);
  await rejected;
  await app.host.send([{t: 'error', message: 'Late control error'}]);
  await app.flush();
  await assert.rejects(app.connection.refreshSnapshot(() => {}), /already in progress/);
  await app.host.send([welcome, emptySnapshot]);
  await app.flush();
  assert.deepEqual(app.closeReasons, []);
  assert.ok(app.received.slice(2).every(frame => frame.t !== 'welcome' && frame.t !== 'snapshot-chunk'));
});

test('abort preserves the original cancellation error for a waiting refresh', {timeout: 5000}, async t => {
  const host = await hostFrames([welcome, emptySnapshot]);
  t.after(() => host.close());
  const controller = new AbortController();
  const closeReasons: string[] = [];
  const connection = await connectCollab(host.binding, 'Guest', {
    onFrame() {},
    onClose(reason) { closeReasons.push(reason); },
  }, controller.signal);
  t.after(() => connection.close());
  await host.nextGuest();
  const diagnostic = new Error('Original cancellation\nRefresh diagnostic');
  const refreshing = connection.refreshSnapshot(() => {});
  const rejected = assert.rejects(refreshing, error => error === diagnostic);
  await host.nextGuest();
  controller.abort(diagnostic);
  await rejected;
  assert.deepEqual(closeReasons, [diagnostic.message]);
});

