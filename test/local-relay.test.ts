import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startLocalRelay } from '../src/local-relay.js';

// A native snapshot can contain many small chunks in one TCP read. Outstanding
// send callbacks are not evidence that a loopback guest cannot keep up.
test('relay forwards coalesced frame bursts without disconnecting a draining guest', { timeout: 15000 }, async t => {
  const failures: unknown[] = [];
  const relay = await startLocalRelay({ report: (operation, error) => failures.push(new Error(operation, { cause: error })) });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await relay.close();
    if (failures.length) throw new AggregateError(failures, failures.map(error => String(error instanceof Error ? error.cause : error)).join('\n'));
  });
  const host = new WebSocket(`${relay.url}/r/burst-regression?role=host`, { perMessageDeflate: false });
  sockets.push(host);
  await once(host, 'open', { signal: t.signal });
  const joined = once(host, 'message', { signal: t.signal });
  const guest = new WebSocket(`${relay.url}/r/burst-regression?role=guest`, { perMessageDeflate: false });
  sockets.push(guest);
  await once(guest, 'open', { signal: t.signal });
  const [control] = await joined;
  const peer = JSON.parse(String(control)).peer as number;
  const received: number[] = [];
  const completed = Promise.withResolvers<void>();
  guest.on('message', (data, binary) => {
    if (!binary) return;
    const frame = data as Buffer;
    received.push(frame.readUInt32BE(4));
    if (received.length === 4288) completed.resolve();
  });
  guest.on('close', code => completed.reject(new Error(`Guest closed before burst completion (${code})`)));
  guest.on('error', completed.reject);
  // Deliberately stop the consumer while the producer queues more than the
  // relay's budget. This is a transport condition, not a latency assertion.
  guest.pause();
  const resume = delay(500, undefined, { signal: t.signal }).then(() => guest.resume());
  for (let index = 0; index < 4096; index++) {
    const frame = Buffer.alloc(8);
    frame.writeUInt32BE(peer, 0);
    frame.writeUInt32BE(index, 4);
    host.send(frame);
  }
  // Follow the small-frame burst with more than the relay's total byte budget;
  // a draining peer must receive the whole snapshot, not just its first window.
  for (let index = 4096; index < 4288; index++) {
    const frame = Buffer.alloc(512 * 1024);
    frame.writeUInt32BE(peer, 0);
    frame.writeUInt32BE(index, 4);
    host.send(frame);
  }
  await completed.promise;
  await resume;
  assert.deepEqual(received, Array.from({ length: 4288 }, (_, index) => index));
  const echoed = once(host, 'message', { signal: t.signal });
  const response = Buffer.alloc(8);
  response.writeUInt32BE(0xffffffff, 0);
  response.writeUInt32BE(4096, 4);
  guest.send(response);
  const [envelope] = await echoed;
  assert.equal((envelope as Buffer).readUInt32BE(0), peer);
  assert.equal((envelope as Buffer).readUInt32BE(4), 4096);
});
