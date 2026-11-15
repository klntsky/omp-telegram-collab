import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import { CollabTransportError, connectCollab, readCollabState } from '../src/collab.js';
import { emptySnapshot, hostFrames, state, welcome } from './collab-fixture.js';

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

test('a hello send racing socket closure remains retryable with its original cause', {timeout: 5000}, async t => {
  const host = await hostFrames([]);
  t.after(() => host.close());
  const send = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, 'send', function(this: WebSocket, ...args: Parameters<WebSocket['send']>) {
    this.close(1001, 'Closing during hello send');
    return send.apply(this, args);
  });
  const reasons: string[] = [];
  await assert.rejects(connectCollab(host.binding, 'Guest', {
    onFrame(frame) { assert.fail(`Unexpected frame: ${frame.t}`); },
    onClose(reason) { reasons.push(reason); },
  }), error => {
    assert.ok(error instanceof CollabTransportError);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.message, error.cause.message);
    assert.deepEqual(reasons, [error.message]);
    return true;
  });
});
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

test('initial snapshot callback failures still reject setup with the original error', {timeout: 5000}, async t => {
  const host = await hostFrames([welcome, emptySnapshot]);
  t.after(() => host.close());
  const diagnostic = new Error('Original initial callback failure');
  await assert.rejects(connectCollab(host.binding, 'Guest', {
    onFrame() { throw diagnostic; },
    onClose() {},
  }), error => error === diagnostic);
});
