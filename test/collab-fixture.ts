import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { COLLAB_PROTO, WRITE_TOKEN_BYTES, type GuestFrame, type HostFrame, type SessionEntry } from '@oh-my-pi/pi-wire';
import { connectCollab } from '../src/collab.js';
import { generateRoomKey, importRoomKey, open, seal } from '../src/vendor/codec.js';
import { formatCollabLink, packEnvelope, unpackEnvelope } from '../src/vendor/link.js';

const sessionId = 'handshake-session';
export const state = { cwd: '/fixture', isStreaming: false, queuedMessageCount: 0, participants: [] };
export const welcome: Extract<HostFrame, { t: 'welcome' }> = {
  t: 'welcome', proto: COLLAB_PROTO,
  header: { type: 'session', id: sessionId, cwd: '/fixture', timestamp: new Date(0).toISOString() },
  state, agents: [], entryCount: 0,
};

export async function hostFrames(frames: HostFrame[]) {
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

export const emptySnapshot: Extract<HostFrame, {t: 'snapshot-chunk'}> = {t: 'snapshot-chunk', entries: [], final: true};
export function historyEntry(id: string): SessionEntry {
  return {type: 'custom_message', id, parentId: null, timestamp: new Date(0).toISOString(), customType: 'fixture', content: id, display: true};
}

export async function liveConnection(t: TestContext) {
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
