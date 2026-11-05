import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import type { BrowserHostFrame } from '../shared/contracts.js';
import { GuestClient } from '../web/src/lib/client.js';
import { GatewaySocket } from '../web/src/lib/socket.js';

for (const code of [1011, 4003]) {
  test(`a diagnostic before socket close ${code} follows close-code recovery policy`, {timeout: 10_000}, async t => {
    const server = new WebSocketServer({host: '127.0.0.1', port: 0});
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      const {promise, resolve, reject} = Promise.withResolvers<void>();
      server.close(error => error ? reject(error) : resolve());
      await promise;
    });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {configurable: true, value: {location: {href: `http://127.0.0.1:${address.port}`}}});
    t.after(() => {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    });
    const tickets: string[] = [];
    server.on('connection', (socket, request) => {
      tickets.push(new URL(request.url!, 'http://localhost').searchParams.get('ticket')!);
      const frames: BrowserHostFrame[] = [
        {t: 'welcome', proto: 2, readOnly: true, entryCount: 0,
          header: {type: 'session', id: 'session', cwd: '/work', timestamp: new Date(0).toISOString()},
          state: {isStreaming: false, queuedMessageCount: 0, cwd: '/work', participants: []}, agents: []},
        {t: 'snapshot-chunk', entries: [], final: true},
      ];
      for (const frame of frames) socket.send(JSON.stringify(frame));
    });
    let refreshes = 0;
    const client = new GuestClient(new GatewaySocket('initial', async signal => {
      assert.equal(signal.aborted, false);
      refreshes++;
      return 'refreshed';
    }), 'reader');
    t.after(() => client.close());
    const phases: string[] = [];
    const changed = new EventTarget();
    client.subscribe(() => { phases.push(client.getSnapshot().phase); changed.dispatchEvent(new Event('change')); });
    async function until(predicate: () => boolean): Promise<void> {
      while (!predicate()) await once(changed, 'change', {signal: AbortSignal.timeout(5000)});
    }
    client.connect();
    await until(() => client.getSnapshot().phase === 'live');
    const diagnostic = `Collab room closed\n${'Original host diagnostic '.repeat(10)}`;
    const socket = [...server.clients][0]!;
    socket.send(JSON.stringify({t: 'bye', reason: diagnostic}));
    socket.close(code);
    if (code === 1011) {
      await until(() => refreshes === 1 && client.getSnapshot().phase === 'live');
      assert.deepEqual(tickets, ['initial', 'refreshed']);
      assert.ok(phases.includes('reconnecting'));
      assert.ok(!phases.includes('ended'));
      assert.equal(client.getSnapshot().endedReason, null);
      assert.deepEqual(client.getSnapshot().notices, []);
    } else {
      await until(() => client.getSnapshot().phase === 'ended');
      assert.equal(client.getSnapshot().endedReason, diagnostic);
      assert.equal(refreshes, 0);
      assert.deepEqual(tickets, ['initial']);
    }
  });
}
