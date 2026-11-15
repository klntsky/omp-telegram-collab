import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { BrowserHostFrame, TopicSession } from '../../../shared/contracts.js';
import { issueCredential } from '../../../src/auth.js';
import { createServer } from '../../../src/server.js';
import { GuestClient, type ConnectionPhase, type GuestSnapshot } from '../../../web/src/lib/client.js';
import { GatewaySocket } from '../../../web/src/lib/socket.js';
import { SessionAccessError } from '../../../web/src/lib/telegram.js';
import { bounded } from './async.js';
import type { CollaborationTest } from './collaboration-fixture.js';

export async function observeBrowser(t: TestContext, app: CollaborationTest, session: TopicSession, options: {
  interruptSetup?: () => void;
} = {}) {
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(120000)]);
  const publicUrl = 'https://mini-app.example';
  const config = {
    ...app.config, publicUrl,
    bots: app.config.bots.map(bot => ({ ...bot, miniAppShortName: 'e2e' })),
  };
  let interruptSetup = options.interruptSetup;
  const recovery = {phases: new Set<ConnectionPhase>(), interruptedSetupFailure: undefined as unknown};
  const service = app.service;
  const server = createServer({ config, bots: [{
    id: service.id, token: service.token,
    authorizeSession: service.authorizeSession.bind(service),
    requestCapacity: service.requestCapacity.bind(service),
    onSessionInvalidated: service.onSessionInvalidated.bind(service),
    subscribeSessionFeed: service.subscribeSessionFeed.bind(service),
    async ensureMirroring(...args) {
      const interrupt = interruptSetup;
      interruptSetup = undefined;
      interrupt?.();
      try {
        return await service.ensureMirroring(...args);
      } catch (error) {
        if (interrupt) recovery.interruptedSetupFailure = error;
        throw error;
      }
    },
  }], store: app.store, runtime: app.runtime });
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
  const generation = app.store.getSessionGeneration(session.id);
  const credential = issueCredential({
    botId: app.telegram.bot.id, sessionId: session.id,
    generation, userId: account.id,
    displayName: String(account.id), authDate: Math.floor(Date.now() / 1000),
  }, app.telegram.bot.token);
  app.omp.registerSecret(credential);
  async function authenticate(requestSignal = signal) {
    const response = await fetch(`${origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: requestSignal,
      body: JSON.stringify({ botId: app.telegram.bot.id, sessionId: session.id, initData: credential, credential, generation }),
    });
    if (!response.ok) {
      const diagnostic = await response.text();
      // Match authorizeSession in web/src/lib/telegram.ts so this fixture cannot
      // recover across an access denial or invalidated session generation.
      if ([401, 403, 404, 409].includes(response.status)) throw new SessionAccessError(diagnostic, response.status);
      throw new Error(diagnostic);
    }
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
  const frames: BrowserHostFrame[] = [];
  const {ticket} = await authenticate();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {location: {href: origin}}});
  const transport = new GatewaySocket(ticket, async requestSignal => {
    const refreshed = await authenticate(AbortSignal.any([signal, requestSignal]));
    return refreshed.ticket;
  });
  const client = new GuestClient(transport, String(account.id));
  t.after(() => client.close());
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const receive = transport.onFrame;
  assert.ok(receive);
  transport.onFrame = frame => { frames.push(frame); receive(frame); };
  recovery.phases.add(client.getSnapshot().phase);
  t.after(client.subscribe(() => recovery.phases.add(client.getSnapshot().phase)));
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
    client, frames, waitForSnapshot, recovery,
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
