import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { COLLAB_PROTO, WRITE_TOKEN_BYTES, type HostFrame } from '@oh-my-pi/pi-wire';
import { connectCollab } from '../src/collab.js';
import { generateRoomKey, importRoomKey, seal } from '../src/vendor/codec.js';
import { formatCollabLink, packEnvelope } from '../src/vendor/link.js';

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
  server.on('connection', socket => {
    socket.on('error', () => socket.terminate());
    void (async () => {
      for (const frame of frames) socket.send(packEnvelope(0, await seal(key, frame)));
    })().catch(() => socket.terminate());
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
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
