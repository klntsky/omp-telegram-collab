import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import type { TopicSession } from '../../../shared/contracts.js';
import { issueCredential } from '../../../src/auth.js';
import { createServer } from '../../../src/server.js';
import { GuestClient, type GuestSnapshot } from '../../../web/src/lib/client.js';
import type { GuestTransport } from '../../../web/src/lib/socket.js';
import { bounded } from './async.js';
import type { CollaborationTest } from './collaboration-fixture.js';

export async function observeBrowser(t: TestContext, app: CollaborationTest, session: TopicSession) {
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(120000)]);
  const publicUrl = 'https://mini-app.example';
  const config = {
    ...app.config, publicUrl,
    bots: app.config.bots.map(bot => ({ ...bot, miniAppShortName: 'e2e' })),
  };
  const server = createServer({ config, bots: [app.service], store: app.store, runtime: app.runtime });
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.closeConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  server.listen(0, '127.0.0.1');
  await bounded(once(server, 'listening'), signal);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const account = app.telegram.user.account;
  const credential = issueCredential({
    botId: app.telegram.bot.id, sessionId: session.id,
    generation: app.store.getSessionGeneration(session.id), userId: account.id,
    displayName: String(account.id), authDate: Math.floor(Date.now() / 1000),
  }, app.telegram.bot.token);
  app.omp.registerSecret(credential);
  async function authenticate() {
    const response = await fetch(`${origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ botId: app.telegram.bot.id, sessionId: session.id, initData: credential, credential }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = z.object({ ticket: z.string(), displayName: z.string() }).parse(await response.json());
    app.omp.registerSecret(result.ticket);
    return result;
  }
  async function socket() {
    const { ticket } = await authenticate();
    const connection = new WebSocket(`${origin.replace('http:', 'ws:')}/api/socket?ticket=${encodeURIComponent(ticket)}`, {
      headers: { origin: publicUrl },
    });
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    return connection;
  }
  const frames: HostFrame[] = [];
  let connection: WebSocket;
  const transport: GuestTransport = {
    connect() {
      void socket().then(value => {
        connection = value;
        value.on('open', () => transport.onOpen?.());
        value.on('message', data => {
          const frame = JSON.parse(data.toString()) as HostFrame;
          frames.push(frame);
          transport.onFrame?.(frame);
        });
        value.on('close', (_code, reason) => transport.onClose?.(reason.toString(), false));
        value.on('error', error => transport.onClose?.(error.message, false));
      }).catch(error => transport.onClose?.(String(error), false));
    },
    close() { connection?.close(); },
    reconnect(reason) { transport.onClose?.(reason, false); },
    send(frame) { connection.send(JSON.stringify(frame)); },
  };
  const client = new GuestClient(transport, String(account.id));
  t.after(() => client.close());
  async function waitForSnapshot(predicate: (snapshot: GuestSnapshot) => boolean) {
    const ready = Promise.withResolvers<void>();
    const check = () => {
      const snapshot = client.getSnapshot();
      if (predicate(snapshot)) ready.resolve();
      else if (snapshot.phase === 'ended') ready.reject(new Error(snapshot.endedReason ?? 'Browser session ended'));
    };
    const unsubscribe = client.subscribe(check);
    try { check(); await bounded(ready.promise, signal); } finally { unsubscribe(); }
  }
  client.connect();
  await waitForSnapshot(snapshot => snapshot.phase === 'live');
  assert.ok(frames.some(frame => frame.t === 'welcome' && frame.readOnly));
  return {
    client, frames, waitForSnapshot,
    async denyMutations() {
      const before = await app.runtime.isRunning(session);
      const reopen = await fetch(`${origin}/api/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({
          botId: app.telegram.bot.id, sessionId: session.id, initData: credential, credential,
          generation: app.store.getSessionGeneration(session.id), reopen: true,
        }),
      });
      assert.equal(reopen.status, 403);
      for (const frame of [
        { t: 'prompt', text: 'Browser must not submit this instruction' },
        { t: 'abort' },
        { t: 'agent-cmd', cmd: 'kill', agentId: session.id },
        { t: 'ui-response', reqId: 1, value: 'Browser must not answer' },
      ]) {
        const denied = await socket();
        await bounded(once(denied, 'open'), signal);
        const closed = once(denied, 'close');
        denied.send(JSON.stringify(frame));
        const [code] = await bounded(closed, signal);
        assert.equal(code, 4002);
      }
      assert.equal(await app.runtime.isRunning(session), before);
    },
  };
}
