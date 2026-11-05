import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { COLLAB_PROTO, WRITE_TOKEN_BYTES, type GuestFrame, type HostFrame, type SessionEntry } from '@oh-my-pi/pi-wire';
import { CollabTransportError, connectCollab, readCollabState } from '../src/collab.js';
import { generateRoomKey, importRoomKey, open, seal } from '../src/vendor/codec.js';
import { encodeBase64Url, formatCollabLink, packEnvelope, unpackEnvelope } from '../src/vendor/link.js';

const sessionId = 'handshake-session';
const state = { cwd: '/fixture', isStreaming: false, queuedMessageCount: 0, participants: [] };
const welcome: Extract<HostFrame, { t: 'welcome' }> = {
  t: 'welcome', proto: COLLAB_PROTO,
  header: { type: 'session', id: sessionId, cwd: '/fixture', timestamp: new Date(0).toISOString() },
  state, agents: [], entryCount: 0,
};

async function hostFrames(frames: HostFrame[]) {
  const rawKey = generateRoomKey();
  const key = await importRoomKey(rawKey);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const connected = once(server,'connection');
  const received: GuestFrame[] = [];
  const arrivals = new EventEmitter();
  let nextGuestIndex = 0;
  let connectionCount = 0;
  server.on('connection', socket => {
    connectionCount++;
    let receiveChain = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      receiveChain = receiveChain.then(async () => {
        assert.ok(isBinary);
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        const envelope = unpackEnvelope(bytes);
        assert.ok(envelope);
        received.push(await open(key, envelope.payload) as GuestFrame);
        arrivals.emit('frame');
      }).catch(() => socket.terminate());
    });
    socket.on('error', () => socket.terminate());
    void (async () => {
      for (const frame of frames) socket.send(packEnvelope(0, await seal(key, frame)));
    })().catch(() => socket.terminate());
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    connected,
    get connectionCount() { return connectionCount; },
    async nextGuest() {
      while (nextGuestIndex === received.length) await once(arrivals, 'frame');
      return received[nextGuestIndex++]!;
    },
    async send(nextFrames: HostFrame[]) {
      const [socket] = await connected;
      for (const frame of nextFrames) socket.send(packEnvelope(0, await seal(key, frame)));
    },
    binding: {
      instanceId: 'fixture-host', generation: 1, sessionId,
      url: formatCollabLink(`ws://127.0.0.1:${address.port}`, 'handshake-room', rawKey, new Uint8Array(WRITE_TOKEN_BYTES)),
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close(error => error ? reject(error) : resolve());
      await promise;
    },
  };
}

const emptySnapshot: Extract<HostFrame, {t: 'snapshot-chunk'}> = {t: 'snapshot-chunk', entries: [], final: true};

test('a room closed during setup is retryable without changing its diagnostic', {timeout: 5000}, async t => {
  const host = await hostFrames([]);
  t.after(() => host.close());
  const reasons: string[] = [];
  const connection = connectCollab(host.binding, 'Guest', {
    onFrame(frame) { assert.fail(`Unexpected frame: ${frame.t}`); },
    onClose(reason) { reasons.push(reason); },
  });
  const rejected = assert.rejects(connection, error =>
    error instanceof CollabTransportError && error.message === 'Collab room closed');
  const [socket] = await host.connected;
  socket.send(JSON.stringify({t: 'room-closed'}));
  await rejected;
  assert.deepEqual(reasons, ['Collab room closed']);
});

function historyEntry(id: string): SessionEntry {
  return {type: 'custom_message', id, parentId: null, timestamp: new Date(0).toISOString(), customType: 'fixture', content: id, display: true};
}

async function liveConnection(t: TestContext) {
  const host = await hostFrames([welcome, emptySnapshot]);
  const received: HostFrame[] = [];
  const changes = new EventEmitter();
  const closed = Promise.withResolvers<string>();
  const closeReasons: string[] = [];
  const connection = await connectCollab(host.binding, ' Guest ', {
    onFrame(frame) {
      received.push(frame);
      changes.emit('frame');
    },
    onClose(reason) {
      closeReasons.push(reason);
      closed.resolve(reason);
    },
  });
  t.after(async () => {
    connection.close();
    await host.close();
  });
  const hello = await host.nextGuest();
  assert.equal(hello.t, 'hello');
  async function waitFor(predicate: (frame: HostFrame) => boolean) {
    while (!received.some(predicate)) await once(changes, 'frame');
  }
  let barrier = 0;
  return {
    host, connection, received, closeReasons, closed: closed.promise, hello, waitFor,
    async flush() {
      const cwd = `barrier-${++barrier}`;
      await host.send([{t: 'state', state: {...state, cwd}}]);
      await waitFor(frame => frame.t === 'state' && frame.state.cwd === cwd);
    },
  };
}

test('live host broadcasts before welcome do not reject an authenticated session snapshot', { timeout: 5000 }, async () => {
  const frames: HostFrame[] = [
    { t: 'state', state: { ...state, isStreaming: true } },
    { t: 'event', event: { type: 'agent_start' } },
    welcome,
    { t: 'snapshot-chunk', entries: [], final: true },
  ];
  const host = await hostFrames(frames);
  const received: HostFrame[] = [];
  try {
    const connection = await connectCollab(host.binding, 'Guest', { onFrame: frame => received.push(frame), onClose() {} });
    assert.deepEqual(received, frames);
    connection.close();
  } finally {
    await host.close();
  }
});

test('Collab delivers a snapshot frame beyond the former payload cap', { timeout: 15_000 }, async () => {
  const largeState = { ...state, cwd: 'x'.repeat(17 * 1024 * 1024) };
  const frames: HostFrame[] = [
    { ...welcome, state: largeState },
    { t: 'snapshot-chunk', entries: [], final: true },
  ];
  const host = await hostFrames(frames);
  const received: HostFrame[] = [];
  try {
    const connection = await connectCollab(host.binding, 'Guest', { onFrame: frame => received.push(frame), onClose() {} });
    assert.deepEqual(received, frames);
    connection.close();
  } finally {
    await host.close();
  }
});

for (const [name, frames, reason] of [
  ['snapshot without welcome', [{ t: 'snapshot-chunk', entries: [], final: true }], /snapshot arrived before welcome/],
  ['different session identity', [{ ...welcome, header: { ...welcome.header, id: 'another-session' } }], /session identity mismatch/],
] satisfies [string, HostFrame[], RegExp][]) {
  test(`Collab still rejects ${name}`, { timeout: 5000 }, async () => {
    const host = await hostFrames([...frames]);
    try {
      await assert.rejects(connectCollab(host.binding, 'Guest', { onFrame() {}, onClose() {} }), reason);
    } finally {
      await host.close();
    }
  });
}

test('activity probing reads the validated welcome without waiting for transcript history', {timeout:5000}, async () => {
  const host = await hostFrames([
    {t:'state',state:{...state,isStreaming:true,queuedMessageCount:2}},
    {...welcome,entryCount:1000},
  ]);
  try {
    assert.deepEqual(await readCollabState(host.binding,'Activity probe'),state);
    const [socket] = await host.connected;
    if (socket.readyState !== 3) await once(socket,'close');
  } finally { await host.close(); }
});

test('canceling an activity probe preserves its diagnostic and closes the socket', {timeout:5000}, async () => {
  const host = await hostFrames([]);
  const controller = new AbortController();
  const diagnostic = new Error('Activity observation canceled\nOriginal operation diagnostic');
  try {
    const reading = readCollabState(host.binding,'Activity probe',controller.signal);
    const [socket] = await host.connected;
    const closed = once(socket,'close');
    controller.abort(diagnostic);
    await assert.rejects(reading,error => error === diagnostic);
    await closed;
  } finally { await host.close(); }
});

for (const [label,frame,reason] of [
  ['wrong identity',{...welcome,header:{...welcome.header,id:'another-session'}},/session identity mismatch/],
  ['refused control',{...welcome,readOnly:true},/host refused control access/],
  ['negative queue',{...welcome,state:{...state,queuedMessageCount:-1}},/Invalid Collab activity state/],
  ['missing activity',{...welcome,state:{} as typeof state},/Invalid Collab activity state/],
] satisfies [string,HostFrame,RegExp][]) {
  test(`activity probing rejects ${label}`, {timeout:5000}, async () => {
    const host = await hostFrames([frame]);
    try { await assert.rejects(readCollabState(host.binding,'Activity probe'),reason); }
    finally { await host.close(); }
  });
}

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

test('initial snapshot callback failures still reject setup with the original error', {timeout: 5000}, async t => {
  const host = await hostFrames([welcome, emptySnapshot]);
  t.after(() => host.close());
  const diagnostic = new Error('Original initial callback failure');
  await assert.rejects(connectCollab(host.binding, 'Guest', {
    onFrame() { throw diagnostic; },
    onClose() {},
  }), error => error === diagnostic);
});
