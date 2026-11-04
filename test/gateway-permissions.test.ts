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
import type { BrowserHostFrame, HistoryCursor } from '../shared/contracts.js';
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
    const frames: BrowserHostFrame[] = [];
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

test('warm viewers share mirroring while paging and private transcript reads stay isolated', async () => {
  const {app, session, connect} = await fixture();
  const sockets: WebSocket[] = [];
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'shared feed output missing');
      await delay(10);
    }
  };
  try {
    for (let i = 0; i < 245; i++) app.appendEntry({
      type: 'custom_message', id: `history-${i}`, parentId: null, timestamp: '2026-01-01T00:00:00Z',
      customType: 'fixture', content: String(i), display: true,
    });
    await app.service.ensureMirroring(session, await app.runtime.ensure(session));
    const connections = app.connectionCount;
    const first = await connect(); sockets.push(first.socket);
    const second = await connect(); sockets.push(second.socket);
    assert.equal(app.connectionCount, connections, 'viewers must reuse the persistent bot connection');
    const recent = first.frames.find(frame => frame.t === 'snapshot-chunk');
    const initial = first.frames.find(frame => frame.t === 'history-state');
    assert.ok(recent?.t === 'snapshot-chunk');
    assert.ok(initial?.t === 'history-state' && initial.older);
    assert.deepEqual(recent.entries.map(entry => entry.id), Array.from({length: 100}, (_, i) => `history-${i + 145}`));
    const seen = new Set(recent.entries.map(entry => entry.id));
    let cursor: HistoryCursor | null = initial.older;
    let reqId = 1;
    while (cursor) {
      const requested: HistoryCursor = cursor;
      const requestId = reqId++;
      first.socket.send(JSON.stringify({t: 'history-page', reqId: requestId, cursor: requested}));
      app.emit({t: 'state', state: {cwd: session.cwd, isStreaming: true, queuedMessageCount: requestId, participants: []}});
      await waitFor(() => first.frames.some(frame => frame.t === 'history-page' && frame.reqId === requestId) &&
        first.frames.some(frame => frame.t === 'state' && frame.state.queuedMessageCount === requestId));
      const reply = first.frames.find(frame => frame.t === 'history-page' && frame.reqId === requestId);
      assert.ok(reply?.t === 'history-page');
      assert.deepEqual(reply.cursor, requested);
      assert.ok(reply.page.entries.length <= 100);
      for (const entry of reply.page.entries) {
        assert.ok(!seen.has(entry.id), 'history pages must not repeat or shift across live frames');
        seen.add(entry.id);
      }
      cursor = reply.page.older;
    }
    assert.equal([...seen].filter(id => id.startsWith('history-')).length, 245);
    assert.ok(!second.frames.some(frame => frame.t === 'history-page'));
    first.socket.send(JSON.stringify({t: 'fetch-transcript', reqId: 1, agentId: 'first-worker', fromByte: 0}));
    second.socket.send(JSON.stringify({t: 'fetch-transcript', reqId: 1, agentId: 'second-worker', fromByte: 0}));
    await waitFor(() => app.accepted.filter(frame => frame.t === 'fetch-transcript').length === 2);
    const requests = app.accepted.filter(frame => frame.t === 'fetch-transcript');
    const firstRequest = requests.find(frame => frame.agentId === 'first-worker');
    const secondRequest = requests.find(frame => frame.agentId === 'second-worker');
    assert.ok(firstRequest && secondRequest);
    assert.notEqual(firstRequest.reqId, secondRequest.reqId);
    app.emit({t: 'transcript', reqId: secondRequest.reqId, text: 'second-private', newSize: 2});
    app.emit({t: 'transcript', reqId: firstRequest.reqId, text: 'first-private', newSize: 1});
    await waitFor(() => first.frames.some(frame => frame.t === 'transcript') && second.frames.some(frame => frame.t === 'transcript'));
    assert.deepEqual(first.frames.filter(frame => frame.t === 'transcript'), [{t: 'transcript', reqId: 1, text: 'first-private', newSize: 1}]);
    assert.deepEqual(second.frames.filter(frame => frame.t === 'transcript'), [{t: 'transcript', reqId: 1, text: 'second-private', newSize: 2}]);
    const firstClosed = once(first.socket, 'close');
    first.socket.close();
    await firstClosed;
    assert.equal(app.activeConnectionCount, 1, 'closing a viewer must leave mirroring alive');
    app.emit({t: 'entry', entry: {type: 'custom_message', id: 'after-viewer-close', parentId: null,
      timestamp: '2026-01-01T00:00:00Z', customType: 'fixture', content: 'still mirrored', display: true}});
    await waitFor(() => second.frames.some(frame => frame.t === 'entry' && frame.entry.id === 'after-viewer-close'));
    const disconnected = once(second.socket, 'close');
    app.disconnect();
    const [code, reason] = await disconnected;
    assert.equal(code, 1011);
    assert.equal(reason.toString(), 'Fixture relay disconnected');
    const fresh = await connect(); sockets.push(fresh.socket);
    const freshHistory = fresh.frames.find(frame => frame.t === 'history-state');
    assert.ok(freshHistory?.t === 'history-state' && freshHistory.older);
    assert.notEqual(freshHistory.older.epoch, initial.older.epoch);
    fresh.socket.send(JSON.stringify({t: 'history-page', reqId: 1, cursor: initial.older}));
    await waitFor(() => fresh.frames.some(frame => frame.t === 'history-reset'));
    const reset = fresh.frames.find(frame => frame.t === 'history-reset');
    assert.ok(reset?.t === 'history-reset');
    assert.deepEqual(reset.page.entries, fresh.frames.find(frame => frame.t === 'snapshot-chunk')?.entries);
    assert.equal(fresh.socket.readyState, WebSocket.OPEN);
  } finally {
    sockets.forEach(socket => socket.terminate());
    await app.close();
  }
});

test('watched rewrites share an ordered refresh and a racing rewrite cannot publish stale pages', {timeout: 15000}, async () => {
  const {app, session, connect} = await fixture();
  const sockets: WebSocket[] = [];
  const gates: {release(): void}[] = [];
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'watched history transition missing');
      await delay(10);
    }
  };
  try {
    const original = Array.from({length: 245}, (_, i) => ({
      type: 'custom_message' as const, id: `history-${i}`, parentId: null,
      timestamp: '2026-01-01T00:00:00Z', customType: 'fixture', content: String(i), display: true,
    }));
    for (const entry of original) app.appendEntry(entry);
    const first = await connect(); sockets.push(first.socket);
    const second = await connect(); sockets.push(second.socket);
    const previous = first.frames.find(frame => frame.t === 'history-state');
    assert.ok(previous?.t === 'history-state' && previous.older);
    const connections = app.connectionCount;
    const gate = app.pauseHistoryRefresh(); gates.push(gate);
    const intermediate = original.filter(entry => entry.id !== 'history-243')
      .map(entry => entry.id === 'history-244' ? {...entry, content: 'intermediate'} : entry);
    app.rewriteHistory(intermediate);
    await gate.started;
    assert.equal(app.historyRefreshCount, 1);
    const joining = connect();
    const replacement = intermediate.filter(entry => entry.id !== 'history-242')
      .map(entry => entry.id === 'history-244' ? {...entry, content: 'latest persisted content'} : entry);
    app.rewriteHistory(replacement);
    app.emit({t: 'state', state: {cwd: session.cwd, isStreaming: true, queuedMessageCount: 0, participants: []}});
    gate.release();
    const joined = await joining; sockets.push(joined.socket);
    await waitFor(() => first.frames.some(frame => frame.t === 'history-reset') && second.frames.some(frame => frame.t === 'history-reset'));
    for (const viewer of [first, second]) {
      const reset = viewer.frames.findLast(frame => frame.t === 'history-reset');
      assert.ok(reset?.t === 'history-reset' && reset.page.older);
      assert.deepEqual(reset.page.entries, replacement.slice(-100));
      assert.notEqual(reset.page.older.epoch, previous.older.epoch);
      assert.equal(viewer.socket.readyState, WebSocket.OPEN);
    }
    assert.deepEqual(joined.frames.find(frame => frame.t === 'snapshot-chunk')?.entries, replacement.slice(-100));
    assert.equal(app.historyRefreshCount, 2);
    assert.equal(app.connectionCount, connections);
    first.socket.send(JSON.stringify({t: 'history-page', reqId: 9, cursor: previous.older}));
    await waitFor(() => first.frames.filter(frame => frame.t === 'history-reset').length === 2);
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    const appended = {...original[0]!, id: 'history-245', content: 'new live output'};
    app.appendEntry(appended);
    app.emit({t: 'entry', entry: appended});
    await waitFor(() => second.frames.some(frame => frame.t === 'entry' && frame.entry.id === appended.id));
    const warm = await connect(); sockets.push(warm.socket);
    assert.deepEqual(warm.frames.find(frame => frame.t === 'snapshot-chunk')?.entries, [...replacement, appended].slice(-100));
    assert.equal(app.historyRefreshCount, 2);
    assert.equal(app.connectionCount, connections);
  } finally {
    for (const gate of gates) gate.release();
    sockets.forEach(socket => socket.terminate());
    await app.close();
  }
});

for (const status of ['member', 'administrator', 'creator'] as const) {
for (const action of [
  { t: 'prompt', text: 'forged instruction' }, { t: 'abort' },
  { t: 'prompt', text: 'image instruction', images: [{type:'image',data:'aA==',mimeType:'image/png'}] },
  { t: 'agent-cmd', cmd: 'kill', agentId: 'worker' },
  { t: 'agent-cmd', cmd: 'revive', agentId: 'worker' },
  { t: 'agent-cmd', cmd: 'chat', agentId: 'worker', text: 'forged subagent instruction' },
  { t: 'ui-response', reqId: 1, value: 'approve' },
  { t: 'ui-response', reqId: 1 },
  { t: 'hello', proto: 3, name: 'forged', writeToken: 'secret' },
]) {
  test(`${status} can watch but cannot send ${action.t}${'cmd' in action ? ` ${action.cmd}` : ''}`, async () => {
    const { app, connect } = await fixture();
    let socket: WebSocket | undefined;
    try {
      app.setCurrentMember({ username: 'viewer', status });
      const reader = await connect(); socket = reader.socket;
      let marked = 0;
      app.runtime.markPrompt = () => { marked++; };
      assert.equal(reader.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
      socket.send(JSON.stringify({t:'fetch-transcript',reqId:700,agentId:'worker',fromByte:0}));
      const deadline = Date.now()+5000;
      while (!app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.agentId === 'worker')) {
        assert.ok(Date.now()<deadline,'reader transcript request missing');
        await delay(10);
      }
      const messagesBefore = app.messages.length;
      const before = app.accepted.length;
      const closed = once(socket, 'close');
      socket.send(JSON.stringify(action));
      const [code, reason] = await closed;
      assert.equal(code, 4002);
      assert.equal(reason.toString(), 'Invalid action');
      assert.equal(app.accepted.length, before);
      assert.equal(marked, 0);
      assert.equal(app.messages.length,messagesBefore);
    } finally { socket?.terminate(); await app.close(); }
  });
}
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
    assert.equal(controller.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
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
    while (!app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.agentId === 'worker')) {
      assert.ok(Date.now() < deadline); await delay(10);
    }
    app.setCurrentMember({status:'creator'});
    const restored = await connect(); sockets.push(restored.socket);
    assert.equal(restored.frames.find(frame => frame.t === 'welcome')?.readOnly, true);
  } finally { sockets.forEach(socket => socket.terminate()); await app.close(); }
});

test('idle membership API failures preserve the original error', async t => {
  const { app, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    t.mock.timers.enable({apis:['setInterval']});
    socket = (await connect()).socket;
    const failure = new Error('Original membership API diagnostic');
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) throw failure;
      return previous(method, payload, signal);
    });
    const before = app.accepted.length;
    const closed = once(socket, 'close');
    t.mock.timers.tick(30000);
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
    assert.equal(reason.toString(), 'Invalid action');
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

test('closed topics disconnect readers and can only be reopened through Telegram', {timeout:15000}, async () => {
  const { app, session, connect } = await fixture();
  let socket: WebSocket | undefined;
  const request = (extra: Record<string,unknown> = {}) => fetch(`${app.url}/api/session`, {
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id),...extra}),
  });
  try {
    socket = (await connect()).socket;
    const closed = once(socket,'close');
    const oldGeneration = app.store.getSessionGeneration(session.id);
    await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
    assert.equal((await closed)[0],4003);
    assert.equal(app.activeConnectionCount,0);
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.store.getSessionGeneration(session.id),oldGeneration+1);
    const response = await request();
    const confirmation = await response.json() as {ticket?:string;generation:number;credential:string;canReopen?:boolean};
    assert.equal(response.status,200);
    assert.equal(confirmation.ticket,undefined);
    assert.equal(confirmation.canReopen,undefined);
    assert.deepEqual(app.reopenedTopics,[]);
    app.setCurrentMember({status:'member'});
    const denied = await request({reopen:true,generation:confirmation.generation,credential:confirmation.credential});
    assert.equal(denied.status,403);
    assert.equal(app.store.getSession(session.id)?.status,'closed');
    assert.deepEqual(app.reopenedTopics,[]);
    const member = await (await request()).json() as {canReopen?:boolean;ticket?:string};
    assert.equal(member.canReopen,undefined);
    assert.equal(member.ticket,undefined);
    app.setCurrentMember({status:'creator'});
    const deniedAdmin = await request({reopen:true,generation:confirmation.generation,credential:confirmation.credential});
    assert.equal(deniedAdmin.status,403);
    assert.equal(app.store.getSession(session.id)?.status,'closed');
    assert.deepEqual(app.reopenedTopics,[]);
    await app.update({message_thread_id:session.threadId,forum_topic_reopened:{}});
    assert.equal(app.store.getSession(session.id)?.status,'open');
    assert.equal(await app.runtime.isRunning(session),false);
    socket = (await connect()).socket;
    assert.equal(await app.runtime.isRunning(session),true);
    const closedAgain = once(socket,'close');
    await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
    await closedAgain;
    assert.equal(app.activeConnectionCount,0);
    assert.equal(await app.runtime.isRunning(session),false);
  } finally { socket?.terminate(); await app.close(); }
});

test('multiline idle authorization diagnostics retain the original message', async t => {
  const { app, connect } = await fixture();
  let socket: WebSocket | undefined;
  try {
    t.mock.timers.enable({apis:['setInterval']});
    const controller = await connect(); socket = controller.socket;
    const message = `Membership lookup failed:\n${'詳細診断'.repeat(60)}\nOriginal diagnostic retained.`;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === 'getChatMember' && 'user_id' in payload && Number(payload.user_id) === ownerId) throw new Error(message);
      return previous(method, payload, signal);
    });
    const before = app.accepted.length;
    const closed = once(socket, 'close');
    t.mock.timers.tick(30000);
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
        !app.accepted.some(frame => frame.t === 'fetch-transcript' && frame.agentId === 'worker')) {
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
      if (change === 'assignment') app.config.instances.find(instance => instance.id === session.instanceId)!.chats = [];
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
  test(`authorization preserves diagnostics and classifies Telegram ${failureKind} failures`, async t => {
    const { app, session, connect } = await fixture();
    let socket: WebSocket | undefined;
    try {
      t.mock.timers.enable({apis:['setInterval']});
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
      t.mock.timers.tick(30000);
      const [code] = await closed;
      assert.equal(code, transient ? 1013 : 4003);
      assert.equal(app.accepted.length, before, 'failed authorization must not forward requests');
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
