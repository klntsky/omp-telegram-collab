import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { z } from 'zod';
import { startLocalRelay } from '../src/local-relay.js';
const peerNotice = z.object({ t: z.literal('peer-joined'), peer: z.number().int().positive() });

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
}

test('local relay preserves a burst beyond 128 frames and subsequent guest traffic', { timeout: 10_000 }, async t => {
  const failures: unknown[] = [];
  const relay = await startLocalRelay({ report: (_operation, error) => failures.push(error) });
  t.after(() => relay.close());
  const host = await openSocket(`${relay.url}/r/burst-regression?role=host`);
  t.after(() => host.terminate());
  const joined = once(host, 'message');
  const guest = await openSocket(`${relay.url}/r/burst-regression?role=guest`);
  t.after(() => guest.terminate());
  const [notice] = await joined;
  const { peer } = peerNotice.parse(JSON.parse(notice.toString()));
  const sequence: number[] = [];
  const drained = Promise.withResolvers<void>();
  guest.on('message', data => {
    sequence.push((data as Buffer).readUInt32BE(4));
    if (sequence.length === 1000) drained.resolve();
  });
  guest.on('close', code => drained.reject(new Error(`Relay guest closed (${code})`)));
  for (let index = 0; index < 1000; index++) {
    const frame = Buffer.alloc(64);
    frame.writeUInt32BE(peer);
    frame.writeUInt32BE(index, 4);
    host.send(frame);
  }
  await drained.promise;
  assert.deepEqual(sequence, Array.from({ length: 1000 }, (_, index) => index));
  const response = once(host, 'message');
  const instruction = Buffer.alloc(12);
  instruction.writeUInt32BE(987654, 4);
  guest.send(instruction);
  const [received] = await response;
  assert.equal(received.readUInt32BE(0), peer);
  assert.equal(received.readUInt32BE(4), 987654);
  assert.deepEqual(failures, []);
});

test('local relay sheds a stalled guest without losing another guest instruction', { timeout: 10_000 }, async t => {
  const overflow = Promise.withResolvers<unknown>();
  const relay = await startLocalRelay({
    report: (operation, error) => {
      if (operation === 'relay backpressure') overflow.resolve(error);
      else t.diagnostic(`${operation}: ${String(error)}`);
    },
  });
  t.after(() => relay.close());
  const host = await openSocket(`${relay.url}/r/stalled-regression?role=host`);
  t.after(() => host.terminate());
  const joined = once(host, 'message');
  const stalled = await openSocket(`${relay.url}/r/stalled-regression?role=guest`);
  t.after(() => stalled.terminate());
  const [notice] = await joined;
  const { peer } = peerNotice.parse(JSON.parse(notice.toString()));
  const nextJoined = once(host, 'message');
  const healthy = await openSocket(`${relay.url}/r/stalled-regression?role=guest`);
  t.after(() => healthy.terminate());
  const [nextNotice] = await nextJoined;
  const { peer: nextPeer } = peerNotice.parse(JSON.parse(nextNotice.toString()));
  stalled.pause();
  const closed = once(stalled, 'close');
  const frame = Buffer.alloc(512 * 1024);
  frame.writeUInt32BE(peer);
  for (let index = 0; index < 100; index++) host.send(frame);
  assert.ok(await overflow.promise instanceof Error);
  stalled.resume();
  const [code] = await closed;
  assert.equal(code, 1006);
  const received = Promise.withResolvers<Buffer>();
  host.on('message', (data, binary) => { if (binary) received.resolve(data as Buffer); });
  const instruction = Buffer.alloc(12);
  instruction.writeUInt32BE(123456, 4);
  healthy.send(instruction);
  const delivered = await received.promise;
  assert.equal(delivered.readUInt32BE(0), nextPeer);
  assert.equal(delivered.readUInt32BE(4), 123456);
});
