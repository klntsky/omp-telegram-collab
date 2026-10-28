import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import type { AssistantMessage, HostFrame } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from './telegram-smoke.js';
import { botId } from '../test/telegram-data.js';

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
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
    socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${data.ticket}`, { origin: app.config.publicUrl });
    const frames: HostFrame[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await waitUntil(() => frames.some(frame => frame.t === 'snapshot-chunk'), 'authenticated socket did not receive session snapshot');
    const promptsBeforeRevocation = app.accepted.filter(frame => frame.t === 'prompt').length;
    app.setMember(false);
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
    app.setMember(false);
    const readerClosed = once(reader, 'close');
    const privateReply: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'Private output after membership removal' }],
      model: 'fixture-no-model-call', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    };
    app.emit({ t: 'event', event: { type: 'message_end', message: privateReply } });
    await readerClosed;
    assert.ok(received.every(text => !text.includes('Private output after membership removal')), 'passive reader cannot receive frames after membership removal');
    console.log('PASS Gateway signed Mini App HTTP authorization, private host capability isolation, authenticated socket snapshot, active membership revocation, HTTP denial after removal, and passive reader revocation.');
  } finally {
    socket?.terminate();
    reader?.terminate();
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyGatewayFlow();
}
