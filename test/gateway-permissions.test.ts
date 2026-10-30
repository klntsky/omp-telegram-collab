import assert from 'node:assert/strict';
import { once, getEventListeners } from 'node:events';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { GrammyError, HttpError } from 'grammy';
import { AuthorizationUnavailableError } from '../src/auth.js';
import { createServer } from '../src/server.js';
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

test('Mini App answers enter the response protocol without entering the prompt queue', async () => {
  const { app, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    socket = (await connect()).socket;
    const text = 'Deploy to staging\n  Keep <literal> **text** 😀  ';
    socket.send(JSON.stringify({t:'ui-response',reqId:901,value:text}));
    const deadline = Date.now()+5000;
    while (!app.accepted.some(frame => frame.t === 'ui-response' && frame.reqId === 901)) {
      assert.ok(Date.now() < deadline,'Mini App answer missing from response protocol');
      await delay(10);
    }
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
    const [code] = await closed;
    assert.equal(code, 1013);
    const frames: unknown[] = controller.frames;
    assert.deepEqual(frames.find(frame => frame && typeof frame === 'object' && 't' in frame && frame.t === 'gateway-error'), { t: 'gateway-error', message });
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
        const closed = once(socket, 'close');
        socket.send(JSON.stringify(action));
        await closed;
        assert.equal(app.accepted.length, before);
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

test('backend credential reconnects after launch expiry without permitting fallback or revoked membership', async t => {
  const {app,session} = await fixture();
  let socket: WebSocket | undefined;
  try {
    const initData = app.initData(session.id);
    const exchange = (credential?: string) => fetch(`${app.url}/api/session`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({botId,sessionId:session.id,initData,credential}),
    });
    const initial = await exchange();
    assert.equal(initial.status,200);
    const {credential} = await initial.json() as {credential:string};
    assert.ok(credential);
    assert.equal((await exchange('invalid')).status,403,'invalid credential must not fall back to fresh Telegram data');
    const originalNow = Date.now();
    t.mock.method(Date,'now',() => originalNow + 7200000);
    assert.equal((await exchange()).status,403,'expired launch alone must be rejected');
    const resumed = await exchange(credential);
    assert.equal(resumed.status,200);
    const {ticket} = await resumed.json() as {ticket:string};
    socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${ticket}`,{origin:app.config.publicUrl});
    await once(socket,'open');
    app.setMember(false);
    assert.equal((await exchange(credential)).status,403,'credentials must not cache membership');
  } finally { socket?.terminate(); await app.close(); }
});

test('idle membership lookup outages close recoverably and credential reconnect succeeds after recovery', async t => {
  const { app, session, connect } = await fixture();
  const sockets: WebSocket[] = [];
  try {
    app.setCurrentMember({ username: 'viewer', status: 'member' });
    const exchange = (credential?: string) => fetch(`${app.url}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id), credential }),
    });
    const initial = await exchange();
    assert.equal(initial.status, 200);
    const { credential } = await initial.json() as { credential: string };
    assert.ok(credential);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const reader = await connect(); sockets.push(reader.socket);
    assert.equal(reader.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    const failure = new Error(`Temporary getChatMember transport failure:\n${'詳細診断'.repeat(60)}\nOriginal diagnostic retained.`);
    let unavailable = true;
    let lookups = 0;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) {
        lookups++;
        if (unavailable) throw failure;
      }
      return previous(method, payload, signal);
    });
    const before = app.accepted.length;
    const closed = once(reader.socket, 'close');
    t.mock.timers.tick(30000);
    const [code, reason] = await closed;
    assert.equal(code, 1013);
    assert.equal(reason.toString(), '');
    assert.ok(reader.frames.some((frame: unknown) => typeof frame === 'object' && frame !== null &&
      't' in frame && frame.t === 'gateway-error' && 'message' in frame && frame.message === failure.message));
    assert.ok(!reader.frames.some(frame => frame.t === 'bye'));
    assert.equal(lookups, 1);
    assert.equal(app.accepted.length, before);
    const denied = await exchange(credential);
    assert.equal(denied.status, 503);
    assert.deepEqual(await denied.json(), { error: failure.message });
    assert.equal(lookups, 2);
    assert.equal(app.accepted.length, before);
    unavailable = false;
    const resumed = await exchange(credential);
    assert.equal(resumed.status, 200);
    const { ticket } = await resumed.json() as { ticket: string };
    assert.ok(ticket);
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
    sockets.push(socket);
    const frames: HostFrame[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    const deadline = Date.now() + 5000;
    while (!frames.some(frame => frame.t === 'snapshot-chunk')) {
      assert.ok(Date.now() < deadline, 'recovered connection snapshot missing');
      await delay(10);
    }
    assert.equal(frames.find(frame => frame.t === 'welcome')?.readOnly, true);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(app.accepted.length, before);
  } finally { sockets.forEach(socket => socket.terminate()); await app.close(); }
});

test('idle sockets periodically refresh permissions and close after membership revocation', async t => {
  const {app,session,connect} = await fixture();
  let socket: WebSocket | undefined;
  try {
    t.mock.timers.enable({apis:['setInterval']});
    socket = (await connect()).socket;
    app.setMember(false);
    const closed = once(socket,'close');
    t.mock.timers.tick(30000);
    const [code] = await closed;
    assert.equal(code,4003);
    const response = await fetch(`${app.url}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }),
    });
    assert.equal(response.status, 403);
  } finally { socket?.terminate(); await app.close(); }
});

test('aborted Mini App authentication requests promptly recover all admission capacity', { timeout: 10000 }, async () => {
  const { app, session } = await fixture();
  const clients: ClientRequest[] = [];
  const signals: { aborted: boolean }[] = [];
  const entered = Promise.withResolvers<void>();
  let blocked = true;
  const before = app.accepted.length;
  try {
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (blocked && (method === 'getChat' || method === 'getChatMember')) {
        assert.ok(signal, 'every Telegram authorization read needs cancellation');
        signals.push(signal);
        if (signals.length === 64 * 3) entered.resolve();
        return new Promise<never>(() => {});
      }
      return previous(method, payload, signal);
    });
    const payload = JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) });
    for (let index = 0; index < 64; index++) {
      const client = httpRequest(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      client.on('error', () => {});
      client.end(payload);
      clients.push(client);
    }
    await entered.promise;
    const full = await fetch(`${app.url}/api/session`, { method: 'POST', body: payload });
    assert.equal(full.status, 429);
    await full.arrayBuffer();
    clients.forEach(client => client.destroy());
    const deadline = Date.now() + 2000;
    while (signals.some(signal => !signal.aborted)) {
      assert.ok(Date.now() < deadline, 'abandoned Telegram authorization did not cancel promptly');
      await delay(10);
    }
    blocked = false;
    const recovered = await fetch(`${app.url}/api/session`, { method: 'POST', body: payload });
    assert.equal(recovered.status, 200, 'abandoned requests must not retain pending authentication slots');
    await recovered.arrayBuffer();
    assert.equal(app.accepted.length, before);
  } finally {
    blocked = false;
    clients.forEach(client => client.destroy());
    await app.close();
  }
});

test('authorization cancellation preserves its reason and cleans request listeners despite ignored Telegram signals', { timeout: 5000 }, async () => {
  const { app, session } = await fixture();
  const controller = new AbortController();
  const signals: { aborted: boolean }[] = [];
  try {
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChat' || method === 'getChatMember') {
        assert.ok(signal);
        signals.push(signal);
        return new Promise<never>(() => {});
      }
      return previous(method, payload, signal);
    });
    const reason = new Error('Original caller cancellation diagnostic');
    const lookup = app.service.authorizeSession(session, ownerId, controller.signal);
    const rejected = assert.rejects(lookup, error => error === reason);
    controller.abort(reason);
    await rejected;
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const readsBeforeCancelledCall = signals.length;
    await assert.rejects(app.service.authorizeSession(session, ownerId, controller.signal), error => error === reason);
    assert.equal(signals.length, readsBeforeCancelledCall, 'already cancelled authorization must not start Telegram reads');
  } finally { await app.close(); }
});

for (const boundary of ['authorize', 'authorizeSession'] as const) {
  test(`${boundary} bounds ignored Telegram reads to a ten-second deadline`, async t => {
    const { app, session } = await fixture();
    const signals: { aborted: boolean }[] = [];
    let settled = false;
    try {
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === 'getChat' || method === 'getChatMember') {
          assert.ok(signal);
          signals.push(signal);
          return new Promise<never>(() => {});
        }
        return previous(method, payload, signal);
      });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const lookup = boundary === 'authorize'
        ? app.service.authorize(session.chatId, ownerId)
        : app.service.authorizeSession(session, ownerId);
      const rejected = assert.rejects(lookup, error => {
        settled = true;
        assert.ok(error instanceof AuthorizationUnavailableError);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, 'TimeoutError');
        assert.equal(error.message, error.cause.message);
        return true;
      });
      assert.equal(signals.length, 3);
      t.mock.timers.tick(9999);
      await Promise.resolve();
      assert.equal(settled, false);
      t.mock.timers.tick(1);
      await rejected;
      assert.ok(signals.every(signal => signal.aborted));
    } finally {
      t.mock.timers.reset();
      await app.close();
    }
  });
}

for (const failureKind of [401, 429, 500, 'transport'] as const) {
  test(`authorization preserves diagnostics and classifies Telegram ${failureKind} failures`, async () => {
    const { app, session, connect } = await fixture();
    let socket: WebSocket | undefined;
    try {
      socket = (await connect()).socket;
      const failure = failureKind === 'transport'
        ? new HttpError('Original authorization transport diagnostic', new Error('ECONNRESET'))
        : new GrammyError('Original authorization diagnostic', { ok: false, error_code: failureKind, description: `Original Telegram ${failureKind} diagnostic` }, 'getChatMember', {});
      const transient = failureKind === 'transport' || failureKind === 429 || failureKind >= 500;
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) throw failure;
        return previous(method, payload, signal);
      });
      await assert.rejects(app.service.authorizeSession(session, ownerId), error => {
        if (transient) {
          assert.ok(error instanceof AuthorizationUnavailableError);
          assert.equal(error.cause, failure);
          assert.equal(error.message, failure.message);
        } else assert.equal(error, failure);
        return true;
      });
      const response = await fetch(`${app.url}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }),
      });
      assert.equal(response.status, transient ? 503 : 403);
      assert.deepEqual(await response.json(), { error: failure.message });
      const before = app.accepted.length;
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ t: 'abort' }));
      const [code] = await closed;
      assert.equal(code, transient ? 1013 : 4003);
      assert.equal(app.accepted.length, before, 'failed authorization must not execute mutations');
    } finally { socket?.terminate(); await app.close(); }
  });
}

test('gateway shutdown cancels pending HTTP authorization even when Telegram ignores cancellation', { timeout: 5000 }, async () => {
  const { app, session } = await fixture();
  const entered = Promise.withResolvers<void>();
  const signals: { aborted: boolean }[] = [];
  let client: ClientRequest | undefined;
  const gateway = createServer({ config: app.config, bots: [app.service], store: app.store, runtime: app.runtime });
  try {
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    assert.ok(address && typeof address !== 'string');
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChat' || method === 'getChatMember') {
        assert.ok(signal);
        signals.push(signal);
        if (signals.length === 3) entered.resolve();
        return new Promise<never>(() => {});
      }
      return previous(method, payload, signal);
    });
    client = httpRequest(`http://127.0.0.1:${address.port}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    client.on('error', () => {});
    client.end(JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }));
    await entered.promise;
    await gateway.closeConnections();
    assert.ok(signals.every(signal => signal.aborted));
  } finally {
    client?.destroy();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    gateway.close(error => error ? reject(error) : resolve());
    await promise;
    await app.close();
  }
});

test('bot shutdown preserves lifecycle cancellation for authorization with ignored Telegram signals', { timeout: 5000 }, async () => {
  const { app, session } = await fixture();
  const signals: { aborted: boolean }[] = [];
  try {
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChat' || method === 'getChatMember') {
        assert.ok(signal);
        signals.push(signal);
        return new Promise<never>(() => {});
      }
      return previous(method, payload, signal);
    });
    const lookup = app.service.authorizeSession(session, ownerId);
    let cancellation: unknown;
    const rejected = assert.rejects(lookup, error => {
      cancellation = error;
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof AuthorizationUnavailableError));
      return true;
    });
    await app.service.close();
    await rejected;
    assert.ok(signals.every(signal => signal.aborted));
    await assert.rejects(app.service.authorizeSession(session, ownerId), error => error === cancellation);
  } finally { await app.close(); }
});
