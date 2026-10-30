import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import type { AssistantMessage, HostFrame } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from './telegram-smoke.js';
import { botId, ownerUsername } from '../test/telegram-data.js';

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

async function assertUpgradeDenied(url: string, origin: string, message: string) {
  const socket = new WebSocket(url, { origin, handshakeTimeout: 3000 });
  let opened = false;
  let received = false;
  let failed = false;
  socket.on('open', () => { opened = true; socket.close(); });
  socket.on('message', () => { received = true; });
  socket.on('error', () => { failed = true; });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error(`${message}: connection did not close`));
  }, 5000);
  socket.once('close', resolve);
  try {
    await promise;
    assert.equal(opened, false, `${message}: WebSocket upgrade succeeded`);
    assert.equal(received, false, `${message}: private session frames escaped`);
    assert.equal(failed, true, `${message}: handshake was not rejected`);
  } finally {
    clearTimeout(timer);
    socket.terminate();
  }
}

export async function verifyGatewayFlow() {
  const app = await createSmokeApp();
  let socket: WebSocket | undefined;
  let reader: WebSocket | undefined;
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Gateway verification', icon_color: 7322096 } });
    const session = app.store.listSessions(botId)[0]!;
    const authorize = () => fetch(`${app.url}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }),
    });
    const response = await authorize();
    assert.equal(response.status, 200);
    const data = await response.json() as { ticket: string; session: { id: string } };
    assert.equal(data.session.id, session.id);
    assert.ok(!JSON.stringify(data).includes('secret-capability'), 'HTTP session response must not expose the private host capability');
    const socketUrl = `${app.url.replace('http:', 'ws:')}/api/socket?ticket=${encodeURIComponent(data.ticket)}`;
    const connectionsBeforeDeniedUpgrades = app.connectionCount;
    await assertUpgradeDenied(socketUrl, 'https://untrusted.invalid', 'a cross-origin request with a valid ticket must be denied');
    await assertUpgradeDenied(`${socketUrl}&ticket=${encodeURIComponent(data.ticket)}`, app.config.publicUrl, 'duplicate ticket parameters must be denied');
    assert.equal(app.connectionCount, connectionsBeforeDeniedUpgrades, 'denied upgrades must not connect to the private host');
    socket = new WebSocket(socketUrl, { origin: app.config.publicUrl });
    const frames: HostFrame[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await waitUntil(() => frames.some(frame => frame.t === 'snapshot-chunk'), 'authenticated socket did not receive session snapshot');
    const connectionsBeforeReplay = app.connectionCount;
    await assertUpgradeDenied(socketUrl, app.config.publicUrl, 'an already-consumed ticket must not admit another socket');
    assert.equal(app.connectionCount, connectionsBeforeReplay, 'ticket replay must not connect to the private host');
    app.emit({ t: 'error', message: 'original socket remains live after ticket replay' });
    await waitUntil(() => frames.some(frame => frame.t === 'error' && frame.message === 'original socket remains live after ticket replay'), 'rejecting ticket replay disrupted the admitted socket');
    const promptsBeforeRevocation = app.accepted.filter(frame => frame.t === 'prompt').length;
    app.setMember(false);
    app.emit({ t: 'error', message: 'read continuity after membership removal' });
    socket.send(JSON.stringify({ t: 'fetch-transcript', reqId: 901, agentId: 'worker', fromByte: 0 }));
    await waitUntil(() => frames.some(frame => frame.t === 'error' && frame.message === 'read continuity after membership removal') &&
      app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.reqId === 901), 'admitted flow lost output or read-fetch access after removal');
    assert.equal(socket.readyState, WebSocket.OPEN);
    const socketClosed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'prompt', text: 'must be rejected after leaving' }));
    await socketClosed;
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length, promptsBeforeRevocation, 'a removed member cannot send prompts through an existing socket');
    assert.equal((await authorize()).status, 403);
    app.setMember(true);
    const readerResponse = await authorize();
    assert.equal(readerResponse.status, 200);
    const readerData = await readerResponse.json() as { ticket: string };
    reader = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${readerData.ticket}`, { origin: app.config.publicUrl });
    const received: string[] = [];
    reader.on('message', bytes => received.push(bytes.toString()));
    await once(reader, 'open');
    await waitUntil(() => received.some(text => text.includes('snapshot-chunk')), 'reader did not receive initial snapshot');
    app.setCurrentMember({ username: 'ordinary-viewer', status: 'member' });
    const beforeViewerAction = app.accepted.length;
    const deniedViewer = once(reader, 'close');
    reader.send(JSON.stringify({ t: 'abort' }));
    await deniedViewer;
    assert.equal(app.accepted.length, beforeViewerAction, 'a demoted administrator cannot mutate through an admitted socket');
    const viewerResponse = await authorize();
    const viewerData = await viewerResponse.json() as { ticket: string };
    reader = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${viewerData.ticket}`, { origin: app.config.publicUrl });
    const viewerFrames: HostFrame[] = [];
    reader.on('message', bytes => { viewerFrames.push(JSON.parse(bytes.toString())); received.push(bytes.toString()); });
    await once(reader, 'open');
    await waitUntil(() => viewerFrames.some(frame => frame.t === 'snapshot-chunk'), 'viewer did not receive session snapshot');
    assert.equal(viewerFrames.find(frame => frame.t === 'welcome')?.readOnly, true);
    app.setCurrentMember({ username: ownerUsername, status: 'member' });
    app.setMember(false);
    const privateReply: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'Private output after membership removal' }],
      model: 'fixture-no-model-call', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    };
    app.emit({ t: 'event', event: { type: 'message_end', message: privateReply } });
    await waitUntil(() => received.some(text => text.includes('Private output after membership removal')), 'admitted passive reader lost output after membership removal');
    reader.send(JSON.stringify({ t: 'fetch-transcript', reqId: 902, agentId: 'worker', fromByte: 0 }));
    await waitUntil(() => app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.reqId === 902), 'admitted viewer lost read-fetch access');
    assert.equal(reader.readyState, WebSocket.OPEN);
    assert.equal((await authorize()).status, 403, 'a new flow must recheck Telegram membership');
    console.log('PASS Gateway signed Mini App authorization, cross-origin and duplicate-ticket upgrade denial without consuming valid admission, single-use ticket replay denial without disrupting the admitted socket, private capability isolation, authenticated snapshots, viewer read-only startup, fresh mutation authorization, HTTP denial after removal, and flow-scoped output/read-fetch continuity.');
  } finally {
    socket?.terminate();
    reader?.terminate();
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyGatewayFlow();
}
