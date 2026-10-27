import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected state transition did not occur');
    await delay(20);
  }
}

test('anonymous-admin topic closure persists the gateway archive restriction', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Authentication' });
    const session = app.store.listSessions(botId)[0]!;
    await app.update({ message_thread_id: session.threadId, forum_topic_closed: {}, sender_chat: { id: session.chatId, type: 'supergroup', title: 'Fixture project' } }, { id: 1087968824, first_name: 'Group', is_bot: true });
    assert.equal(app.store.getSession(session.id)?.status, 'closed');
    const before = app.accepted.length;
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const data = await response.json() as { ticket: string };
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${data.ticket}`, { origin: app.url });
    const frames: { t: string; readOnly?: boolean }[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk'));
    assert.equal(frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'prompt', text: 'Cannot run in an archived topic' }));
    await closed;
    assert.equal(app.accepted.length, before);
  } finally {
    await app.close();
  }
});

test('another participant starting work does not cancel an explicitly rejected initial task', async () => {
  const app = await createSmokeApp({ competingStartAfterRejection: true });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Preserve this task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Preserve this task' }]);
  } finally {
    await app.close();
  }
});

test('Telegram rate limits recover without shutting down the bot service', async () => {
  const app = await createSmokeApp({ pollingTransientFailure: true });
  const polled = once(app.events, 'poll');
  const running = app.service.start();
  try {
    const outcome = await Promise.race([polled.then(() => 'recovered'), running.then(() => 'stopped', () => 'failed')]);
    assert.equal(outcome, 'recovered');
  } finally {
    await app.close();
    await running.catch(() => undefined);
  }
});

test('a relay disconnect restores mirroring without replaying the admitted prompt', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Finish the task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const before = app.connectionCount;
    app.disconnect();
    const delivered = once(app.events, 'message');
    app.appendEntry({ type: 'message', id: 'missed-output', parentId: null, timestamp: new Date().toISOString(), message: {
      role: 'assistant', content: [{ type: 'text', text: 'Recovered output' }], model: 'fixture', timestamp: Date.now() + 10,
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    } });
    await eventually(() => app.connectionCount > before);
    await delivered;
    assert.equal(app.messages.at(-1)?.text, 'Recovered output');
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Finish the task' }]);
  } finally {
    await app.close();
  }
});
