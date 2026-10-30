import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerId, ownerUsername } from './telegram-data.js';

async function fixture() {
  const app = await createSmokeApp();
  await app.update({ text: '/setup' });
  await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Permissions', icon_color: 7322096 } });
  const session = app.store.listSessions(botId)[0]!;
  async function connect() {
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const { ticket } = await response.json() as { ticket: string };
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
    const frames: HostFrame[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    const deadline = Date.now() + 5000;
    while (!frames.some(frame => frame.t === 'snapshot-chunk')) {
      assert.ok(Date.now() < deadline, 'snapshot missing');
      await delay(10);
    }
    return { socket, frames };
  }
  return { app, session, connect };
}

test('Mini App text answers appear verbatim in the Telegram topic without entering the prompt queue', async () => {
  const { app, session, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    socket = (await connect()).socket;
    const text = 'Deploy to staging\n  Keep <literal> **text** 😀  ';
    const before = app.messages.length;
    socket.send(JSON.stringify({t:'ui-response',reqId:901,value:text}));
    const deadline = Date.now()+5000;
    while (!app.messages.slice(before).some(message => String(message.text).endsWith(text))) {
      assert.ok(Date.now() < deadline,'Mini App answer missing from Telegram topic');
      await delay(10);
    }
    const receipt = app.messages.slice(before).find(message => String(message.text).endsWith(text))!;
    assert.equal(receipt.message_thread_id,session.threadId);
    assert.equal(receipt.text,`@${ownerUsername} answered: ${text}`);
    assert.ok(app.accepted.some(frame => frame.t === 'ui-response' && frame.reqId === 901 && frame.value === text));
    assert.ok(!app.accepted.some(frame => frame.t === 'prompt' && frame.text === text));
  } finally { socket?.terminate(); await app.close(); }
});

for (const action of [
  { t: 'prompt', text: 'forged instruction' }, { t: 'abort' },
  { t: 'agent-cmd', cmd: 'kill', agentId: 'worker' },
  { t: 'agent-cmd', cmd: 'revive', agentId: 'worker' },
  { t: 'agent-cmd', cmd: 'chat', agentId: 'worker', text: 'forged subagent instruction' },
  { t: 'ui-response', reqId: 1, value: 'approve' },
]) {
  test(`ordinary members can watch but cannot forge ${action.t}${'cmd' in action ? ` ${action.cmd}` : ''}`, async () => {
    const { app, connect } = await fixture();
    let socket: WebSocket | undefined;
    try {
      app.setCurrentMember({ username: 'viewer', status: 'member' });
      const reader = await connect(); socket = reader.socket;
      let marked = 0, relayed = 0;
      app.runtime.markPrompt = () => { marked++; };
      app.service.relayPrompt = async () => { relayed++; };
      assert.equal(reader.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
      const before = app.accepted.length;
      const closed = once(socket, 'close');
      socket.send(JSON.stringify(action));
      await closed;
      assert.equal(app.accepted.length, before);
      assert.equal(marked, 0);
      assert.equal(relayed, 0);
    } finally { socket?.terminate(); await app.close(); }
  });
}

test('current native role controls reconnect access regardless of username', async () => {
  const { app, session, connect } = await fixture();
  const sockets: WebSocket[] = [];
  try {
    app.setCurrentMember({ username: 'viewer', status: 'member' });
    assert.equal(await app.service.authorizeSession(session, ownerId), false);
    app.setCurrentMember({status:'administrator'});
    assert.equal(await app.service.authorizeSession(session, ownerId), true);
    const controller = await connect(); sockets.push(controller.socket);
    assert.equal(controller.frames.find(frame => frame.t === 'welcome')?.readOnly, false);
    app.setCurrentMember({ username: 'renamed', status: 'member' });
    const before = app.accepted.length;
    const closed = once(controller.socket, 'close');
    controller.socket.send(JSON.stringify({ t: 'abort' }));
    await closed;
    assert.equal(app.accepted.length, before);
    const reader = await connect(); sockets.push(reader.socket);
    assert.equal(reader.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    const transcript = { t: 'fetch-transcript', reqId: 900, agentId: 'worker', fromByte: 0 };
    reader.socket.send(JSON.stringify(transcript));
    const deadline = Date.now() + 5000;
    while (!app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.reqId === 900)) {
      assert.ok(Date.now() < deadline); await delay(10);
    }
    app.setCurrentMember({status:'creator'});
    const restored = await connect(); sockets.push(restored.socket);
    assert.equal(restored.frames.find(frame => frame.t === 'welcome')?.readOnly, false);
  } finally { sockets.forEach(socket => socket.terminate()); await app.close(); }
});

test('membership API failures preserve the original error and deny mutations', async () => {
  const { app, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    socket = (await connect()).socket;
    const failure = new Error('Original membership API diagnostic');
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) throw failure;
      return previous(method, payload, signal);
    });
    const before = app.accepted.length;
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'abort' }));
    const [, reason] = await closed;
    assert.equal(reason.toString(), failure.message);
    assert.equal(app.accepted.length, before);
  } finally { socket?.terminate(); await app.close(); }
});

test('raw host read-only cannot be bypassed by a domain admin', async () => {
  const { app, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    const controller = await connect(); socket = controller.socket;
    const welcome = controller.frames.find(frame => frame.t === 'welcome');
    assert.ok(welcome && welcome.t === 'welcome');
    app.emit({ ...welcome, readOnly: true });
    await delay(30);
    const before = app.accepted.length;
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'abort' }));
    const [, reason] = await closed;
    assert.equal(reason.toString(), 'Host is read-only');
    assert.equal(app.accepted.length, before);
  } finally { socket?.terminate(); await app.close(); }
});

for (const change of ['membership', 'generation'] as const) {
  test(`host startup rechecks ${change} after runtime admission`, async () => {
    const { app, session } = await fixture();
    let socket: WebSocket | undefined;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const ensure = app.runtime.ensure.bind(app.runtime);
    app.runtime.ensure = async (current, beforeMutation) => {
      entered.resolve();
      await resume.promise;
      return ensure(current, beforeMutation);
    };
    try {
      const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
      const { ticket } = await response.json() as { ticket: string };
      socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
      const frames: HostFrame[] = [];
      socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
      const closed = once(socket, 'close');
      await entered.promise;
      if (change === 'membership') app.setMember(false);
      else app.store.advanceSessionGeneration(session.id);
      resume.resolve();
      await closed;
      assert.equal(frames.length, 0);
    } finally { resume.resolve(); socket?.terminate(); await app.close(); }
  });
}

test('archived topics deny admin mutations while retaining watch access', async () => {
  const { app, session, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    await app.update({ message_thread_id: session.threadId, forum_topic_closed: {} });
    const reader = await connect(); socket = reader.socket;
    assert.equal(reader.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    const before = app.accepted.length;
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'abort' }));
    const [, reason] = await closed;
    assert.equal(reason.toString(), 'Archived session');
    assert.equal(app.accepted.length, before);
  } finally { socket?.terminate(); await app.close(); }
});

test('multiline authorization diagnostics exceed close limits without losing the original message', async () => {
  const { app, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    const controller = await connect(); socket = controller.socket;
    const message = `Membership lookup failed:\n${'詳細診断'.repeat(60)}\nOriginal diagnostic retained.`;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) throw new Error(message);
      return previous(method, payload, signal);
    });
    const before = app.accepted.length;
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'abort' }));
    await closed;
    assert.ok(controller.frames.some(frame => frame.t === 'bye' && frame.reason === message));
    assert.equal(app.accepted.length, before);
  } finally { socket?.terminate(); await app.close(); }
});

for (const change of ['role', 'membership'] as const) {
  test(`admitted readers retain output and fetch access after Telegram ${change} changes`, async () => {
    const { app, session, connect } = await fixture();
    const sockets: WebSocket[] = [];
    try {
      const controller = await connect(); sockets.push(controller.socket);
      if (change === 'role') app.setCurrentMember({ username: 'viewer', status: 'member' });
      else app.setMember(false);
      app.emit({ t: 'error', message: 'output admitted for this flow' });
      controller.socket.send(JSON.stringify({ t: 'fetch-transcript', reqId: 902, agentId: 'worker', fromByte: 0 }));
      const deadline = Date.now() + 5000;
      while (!controller.frames.some(frame => frame.t === 'error' && frame.message === 'output admitted for this flow') ||
        !app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.reqId === 902)) {
        assert.ok(Date.now() < deadline, 'admitted flow lost read access');
        await delay(10);
      }
      assert.equal(controller.socket.readyState, WebSocket.OPEN);
      const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
      assert.equal(response.status, change === 'membership' ? 403 : 200);
      if (change === 'role') {
        const reader = await connect(); sockets.push(reader.socket);
        assert.equal(reader.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
      }
    } finally { sockets.forEach(socket => socket.terminate()); await app.close(); }
  });
}

for (const change of ['role', 'assignment', 'generation'] as const) {
  test(`mutations recheck ${change} changed during membership lookup`, async () => {
    const { app, session, connect } = await fixture();
    let socket: WebSocket | undefined;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    try {
      app.setCurrentMember({ status: 'creator' });
      socket = (await connect()).socket;
      let held = false;
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (!held && method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) {
          held = true; entered.resolve(); await resume.promise;
        }
        return previous(method, payload, signal);
      });
      const before = app.accepted.length;
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ t: 'prompt', text: 'must not pass a stale authorization' }));
      socket.send(JSON.stringify({ t: 'abort' }));
      await entered.promise;
      if (change === 'role') app.setCurrentMember({status:'member'});
      else if (change === 'assignment') app.config.instances[session.instancePath]!.chats = [];
      else app.store.advanceSessionGeneration(session.id);
      resume.resolve();
      await closed;
      assert.equal(app.accepted.length, before);
    } finally { resume.resolve(); socket?.terminate(); await app.close(); }
  });
}

for (const change of ['membership', 'role'] as const) {
  test(`queued mutations recheck ${change} immediately before execution`, async () => {
    const { app, connect } = await fixture();
    let socket: WebSocket | undefined;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const relay = app.service.relayAnswer.bind(app.service);
    app.service.relayAnswer = async (...args) => {
      entered.resolve();
      await resume.promise;
      await relay(...args);
    };
    try {
      socket = (await connect()).socket;
      socket.send(JSON.stringify({ t: 'ui-response', reqId: 901, value: 'authorized before revocation' }));
      await entered.promise;
      assert.ok(app.accepted.some(frame => frame.t === 'ui-response' && frame.reqId === 901 && frame.value === 'authorized before revocation'));
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ t: 'abort' }));
      if (change === 'membership') app.setMember(false);
      else app.setCurrentMember({ status: 'member' });
      resume.resolve();
      await closed;
      assert.ok(!app.accepted.some(frame => frame.t === 'abort'), 'queued mutation used authorization from before it reached execution');
    } finally { resume.resolve(); socket?.terminate(); await app.close(); }
  });
}

for (const change of ['membership', 'role'] as const) {
  for (const action of [
    { t: 'prompt', text: 'revoked instruction' }, { t: 'abort' },
    { t: 'agent-cmd', cmd: 'kill', agentId: 'worker' },
    { t: 'agent-cmd', cmd: 'revive', agentId: 'worker' },
    { t: 'agent-cmd', cmd: 'chat', agentId: 'worker', text: 'revoked subagent instruction' },
    { t: 'ui-response', reqId: 903, value: 'approve' },
  ]) {
    test(`fresh ${change} revocation denies admitted ${action.t}${'cmd' in action ? ` ${action.cmd}` : ''}`, async () => {
      const { app, connect } = await fixture();
      let socket: WebSocket | undefined;
      try {
        socket = (await connect()).socket;
        if (change === 'membership') app.setMember(false);
        else app.setCurrentMember({ status: 'member' });
        const before = app.accepted.length;
        const messagesBefore = app.messages.length;
        const closed = once(socket, 'close');
        socket.send(JSON.stringify(action));
        await closed;
        assert.equal(app.accepted.length, before);
        assert.ok(!app.messages.slice(messagesBefore).some(message => String(message.text).includes('answered: approve')));
      } finally { socket?.terminate(); await app.close(); }
    });
  }
}

for (const change of ['assignment', 'generation'] as const) {
  test(`local ${change} invalidation still blocks admitted output`, async () => {
    const { app, session, connect } = await fixture();
    let socket: WebSocket | undefined;
    try {
      const reader = await connect(); socket = reader.socket;
      if (change === 'assignment') app.config.instances[session.instancePath]!.chats = [];
      else app.store.advanceSessionGeneration(session.id);
      const closed = once(socket, 'close');
      app.emit({ t: 'error', message: 'must not cross local invalidation' });
      await closed;
      assert.ok(!reader.frames.some(frame => frame.t === 'error' && frame.message === 'must not cross local invalidation'));
    } finally { socket?.terminate(); await app.close(); }
  });
}

test('an admitted ticket retains read access through warm upgrade and initialization', async () => {
  const { app, session, connect } = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const initial = await connect(); sockets.push(initial.socket);
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const { ticket } = await response.json() as { ticket: string };
    app.setMember(false);
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
    sockets.push(socket);
    const frames: HostFrame[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    const deadline = Date.now() + 5000;
    while (!frames.some(frame => frame.t === 'snapshot-chunk')) {
      assert.ok(Date.now() < deadline, 'admitted warm flow lost initialization access');
      await delay(10);
    }
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally { sockets.forEach(socket => socket.terminate()); await app.close(); }
});
