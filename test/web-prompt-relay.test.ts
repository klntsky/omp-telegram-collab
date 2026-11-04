import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerUsername, signedInitData } from './telegram-data.js';
import { GuestClient } from '../web/src/lib/client.js';
import { GatewaySocket } from '../web/src/lib/socket.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected reader state transition');
    await delay(10);
  }
}

for (const username of [ownerUsername, undefined, '']) {
  test(`Mini App readers retain authenticated ${username ? 'username' : username === '' ? 'empty-username fallback' : 'numeric identity'}`, async () => {
    const app = await createSmokeApp();
    let socket: WebSocket | undefined;
    try {
      await app.update({ text: '/setup' });
      await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Web prompt destination' } });
      await app.update({ message_thread_id: 43, forum_topic_created: { name: 'Other topic' } });
      const session = app.store.listSessions(botId).find(value => value.threadId === 42)!;
      const initData = signedInitData(session.id, {
        extra: { user: JSON.stringify({ id: 42, first_name: 'Ada', username, is_bot: false }) },
      });
      const response = await fetch(`${app.url}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, sessionId: session.id, initData }),
      });
      assert.equal(response.status, 200);
      const { ticket, displayName } = await response.json() as { ticket: string; displayName: string };
      const participant = username ? `@${username}` : 'user ID 42';
      assert.equal(displayName, participant);
      socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
      let ready = false;
      socket.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.t === 'snapshot-chunk' && frame.final) ready = true;
      });
      await waitFor(() => ready);
      const before = app.accepted.length;
      socket.send(JSON.stringify({ t: 'fetch-transcript', reqId: 1, agentId: 'worker', fromByte: 0 }));
      await waitFor(() => app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.reqId === 1));
      assert.equal(app.accepted.length,before+1);
    } finally {
      socket?.terminate();
      await app.close();
    }
  });
}


test('a retryable gateway diagnostic before welcome reconnects without ending the client', async t => {
  const app = await createSmokeApp();
  let client: GuestClient | undefined;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Pre-welcome recovery' } });
    app.setCurrentMember({ status: 'member' });
    const session = app.store.listSessions(botId)[0]!;
    const request = { botId, sessionId: session.id, initData: app.initData(session.id) };
    const response = await fetch(`${app.url}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    const initial = await response.json() as { ticket: string; credential: string; generation: number; displayName: string };
    const originalEnsure = app.runtime.ensure.bind(app.runtime);
    t.mock.method(app.runtime, 'ensure', async (...[current, beforeMutation]: Parameters<typeof originalEnsure>) => {
      await beforeMutation?.();
      return originalEnsure(current, beforeMutation);
    });
    let failNextLookup = true;
    const failure = new Error(`Temporary Telegram lookup outage\n${'Original transport diagnostic '.repeat(8)}`);
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (failNextLookup && method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === 42) {
        failNextLookup = false;
        throw failure;
      }
      return previous(method, payload, signal);
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: app.url } } });
    let refreshes = 0;
    const transport = new GatewaySocket(initial.ticket, async signal => {
      refreshes++;
      const refreshed = await fetch(`${app.url}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ ...request, credential: initial.credential, generation: initial.generation }),
      });
      assert.equal(refreshed.status, 200);
      return (await refreshed.json() as { ticket: string }).ticket;
    });
    client = new GuestClient(transport, initial.displayName);
    let ended = false;
    const connectionNoticeIds = new Set<number>();
    client.subscribe(() => {
      const snapshot = client!.getSnapshot();
      if (snapshot.phase === 'ended') ended = true;
      if (snapshot.phase === 'reconnecting') {
        for (const notice of snapshot.notices) connectionNoticeIds.add(notice.id);
      }
    });
    client.connect();
    await waitFor(() => client!.getSnapshot().phase === 'live');
    assert.equal(ended, false);
    assert.equal(refreshes, 1);
    assert.ok(connectionNoticeIds.size > 0);
    assert.deepEqual(client.getSnapshot().notices.filter(notice => connectionNoticeIds.has(notice.id)), []);
    assert.deepEqual(app.accepted, []);
  } finally {
    client?.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    await app.close();
  }
});
