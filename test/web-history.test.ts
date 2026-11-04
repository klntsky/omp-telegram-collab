import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage, SessionEntry } from '@oh-my-pi/pi-wire';
import type { BrowserFrame, BrowserHostFrame, HistoryCursor } from '../shared/contracts.js';
import { GuestClient } from '../web/src/lib/client.js';
import type { GuestTransport } from '../web/src/lib/socket.js';

class Transport implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: BrowserHostFrame) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: BrowserFrame[] = [];
  connect(): void { this.onOpen?.(); }
  reconnect(reason: string): void { this.onClose?.(reason, true); }
  close(): void { this.onClose?.('Closed', false); }
  send(frame: BrowserFrame): void { this.sent.push(frame); }
  receive(frame: BrowserHostFrame): void { this.onFrame?.(frame); }
  historyRequest(): Extract<BrowserFrame, {t: 'history-page'}> {
    const request = this.sent.findLast(frame => frame.t === 'history-page');
    assert.ok(request?.t === 'history-page');
    return request;
  }
}

const timestamp = '2026-01-01T00:00:00.000Z';
function entry(id: string): SessionEntry {
  return {type: 'message', id, parentId: null, timestamp, message: {role: 'user', content: id, timestamp: 0}};
}
function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: [{type: 'text', text}], model: 'fixture', timestamp: 0, stopReason: 'stop',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {total: 0}},
  };
}
function welcome(transport: Transport, count: number): void {
  transport.receive({
    t: 'welcome', proto: 2, readOnly: true, entryCount: count,
    header: {type: 'session', id: 'session', cwd: '/work', timestamp},
    state: {isStreaming: false, queuedMessageCount: 0, cwd: '/work', participants: []}, agents: [],
  });
}
function ready(transport: Transport, entries: SessionEntry[], older: HistoryCursor | null): void {
  welcome(transport, entries.length);
  transport.receive({t: 'history-state', older});
  transport.receive({t: 'snapshot-chunk', entries, final: true});
}

test('a recent snapshot becomes live independently of unloaded history, then pages preserve concurrent live state', () => {
  const transport = new Transport();
  const client = new GuestClient(transport, 'reader');
  const recent = Array.from({length: 100}, (_, index) => entry(`recent-${index}`));
  const cursor = {epoch: 'first', before: 300};
  try {
    welcome(transport, recent.length);
    transport.receive({t: 'history-state', older: cursor});
    assert.deepEqual(client.getSnapshot().loading, {received: 0, total: 100});
    transport.receive({t: 'snapshot-chunk', entries: recent, final: true});
    assert.equal(client.getSnapshot().phase, 'live');
    assert.equal(client.getSnapshot().entries.length, 100);
    assert.deepEqual(client.getSnapshot().history.older, cursor);
    assert.equal(transport.sent.length, 0);

    client.loadEarlier();
    const request = transport.historyRequest();
    client.loadEarlier();
    assert.equal(transport.sent.length, 1);
    assert.equal(client.getSnapshot().history.loading, true);
    const live = entry('live-during-page');
    transport.receive({t: 'entry', entry: live});
    const stream = assistant('current live response');
    transport.receive({t: 'event', event: {type: 'message_end', message: stream}});
    transport.receive({t: 'event', event: {type: 'tool_execution_start', toolCallId: 'running', toolName: 'bash', args: {command: 'sleep'}}});
    const liveState = client.getSnapshot();
    const historicalAssistant: SessionEntry = {
      type: 'message', id: 'historical-assistant', parentId: null, timestamp, message: assistant('old response'),
    };
    transport.receive({
      ...request, page: {entries: [entry('oldest'), historicalAssistant], older: {epoch: 'first', before: 298}},
    });
    const paged = client.getSnapshot();
    assert.deepEqual(paged.entries.map(value => value.id), ['oldest', 'historical-assistant', ...recent.map(value => value.id), 'live-during-page']);
    assert.equal(paged.entries[2], recent[0]);
    assert.equal(paged.entries.at(-1), live);
    assert.equal(paged.stream, liveState.stream);
    assert.equal(paged.streamDone, true);
    assert.equal(paged.activeTools, liveState.activeTools);
    assert.equal(paged.activeTools.has('running'), true);
    assert.equal(paged.history.loading, false);
    assert.deepEqual(paged.history.older, {epoch: 'first', before: 298});

    transport.receive({...request, page: {entries: [entry('duplicate')], older: null}});
    assert.equal(client.getSnapshot().entries.length, 103);
    client.loadEarlier();
    transport.receive({...transport.historyRequest(), page: {entries: [], older: null}});
    assert.equal(client.getSnapshot().history.older, null);
    assert.equal(client.getSnapshot().entries.length, 103);
  } finally {
    client.close();
  }
});

test('history replies must match request, epoch, and exact requested boundary', () => {
  const transport = new Transport();
  const client = new GuestClient(transport, 'reader');
  try {
    ready(transport, [entry('recent')], {epoch: 'current', before: 20});
    client.loadEarlier();
    const request = transport.historyRequest();
    const entries = client.getSnapshot().entries;
    for (const reply of [
      {...request, reqId: request.reqId + 1},
      {...request, cursor: {epoch: 'other', before: 20}},
      {...request, cursor: {epoch: 'current', before: 19}},
    ]) {
      transport.receive({...reply, page: {entries: [entry('wrong')], older: null}});
      assert.equal(client.getSnapshot().entries, entries);
      assert.equal(client.getSnapshot().history.loading, true);
    }
    transport.receive({...request, page: {entries: [entry('wrong-next-epoch')], older: {epoch: 'other', before: 10}}});
    assert.equal(client.getSnapshot().entries, entries);
    assert.equal(client.getSnapshot().history.loading, true);
    transport.receive({...request, page: {entries: [entry('accepted')], older: null}});
    assert.deepEqual(client.getSnapshot().entries.map(value => value.id), ['accepted', 'recent']);
  } finally {
    client.close();
  }
});

test('history timeout and host error retain rows and cursor and allow explicit retry', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const transport = new Transport();
  const client = new GuestClient(transport, 'reader');
  try {
    const cursor = {epoch: 'epoch', before: 10};
    ready(transport, [entry('recent')], cursor);
    const entries = client.getSnapshot().entries;
    client.loadEarlier();
    const expired = transport.historyRequest();
    t.mock.timers.tick(10_000);
    assert.equal(client.getSnapshot().entries, entries);
    assert.equal(client.getSnapshot().history.loading, false);
    assert.ok(client.getSnapshot().history.error);
    assert.deepEqual(client.getSnapshot().history.older, cursor);
    client.loadEarlier();
    const retry = transport.historyRequest();
    assert.notEqual(retry.reqId, expired.reqId);
    transport.receive({...expired, page: {entries: [entry('too-late')], older: null}});
    assert.equal(client.getSnapshot().entries, entries);
    assert.equal(client.getSnapshot().history.loading, true);
    const error = `Original upstream diagnostic\n${'詳細'.repeat(200)}`;
    transport.receive({t: 'error', message: error});
    assert.equal(client.getSnapshot().entries, entries);
    assert.equal(client.getSnapshot().history.error, error);
    assert.equal(client.getSnapshot().history.loading, false);
    client.loadEarlier();
    assert.equal(client.getSnapshot().history.error, null);
    transport.receive({...transport.historyRequest(), page: {entries: [entry('retried')], older: null}});
    assert.deepEqual(client.getSnapshot().entries.map(value => value.id), ['retried', 'recent']);
  } finally {
    client.close();
  }
});

test('reconnect clears pending reads and rejects old history without disturbing a new request', async () => {
  const transport = new Transport();
  const client = new GuestClient(transport, 'reader');
  try {
    ready(transport, [entry('old-tail')], {epoch: 'old', before: 10});
    client.loadEarlier();
    const stale = transport.historyRequest();
    const transcript = client.fetchTranscript('agent', 0);
    const staleAgent = transport.sent.findLast(frame => frame.t === 'fetch-transcript')!;
    transport.reconnect('Disconnected');
    assert.equal(await transcript, null);
    assert.equal(client.getSnapshot().history.loading, false);
    assert.equal(client.getSnapshot().history.older, null);
    transport.receive({...stale, page: {entries: [entry('stale-before-welcome')], older: null}});
    assert.deepEqual(client.getSnapshot().entries.map(value => value.id), ['old-tail']);
    welcome(transport, 1);
    assert.deepEqual(client.getSnapshot().history, {older: null, loading: false, error: null});
    transport.receive({t: 'history-state', older: {epoch: 'new', before: 50}});
    transport.receive({t: 'snapshot-chunk', entries: [entry('new-tail')], final: true});
    assert.deepEqual(client.getSnapshot().history.older, {epoch: 'new', before: 50});
    client.loadEarlier();
    const current = transport.historyRequest();
    transport.receive({...stale, page: {entries: [entry('stale-after-welcome')], older: null}});
    assert.equal(client.getSnapshot().history.loading, true);
    transport.receive({...current, page: {entries: [entry('new-older')], older: null}});
    assert.deepEqual(client.getSnapshot().entries.map(value => value.id), ['new-older', 'new-tail']);
    const currentAgentRead = client.fetchTranscript('agent', 0);
    const currentAgent = transport.sent.findLast(frame => frame.t === 'fetch-transcript')!;
    let resolved = false;
    void currentAgentRead.then(() => { resolved = true; });
    transport.receive({t: 'transcript', reqId: staleAgent.reqId, text: 'stale transcript', newSize: 16});
    await Promise.resolve();
    assert.equal(resolved, false);
    transport.receive({t: 'transcript', reqId: currentAgent.reqId, text: 'current transcript', newSize: 18});
    assert.deepEqual(await currentAgentRead, {kind: 'rows', text: 'current transcript', newSize: 18});
    ready(transport, [entry('close-tail')], {epoch: 'closing', before: 5});
    client.loadEarlier();
    assert.equal(client.getSnapshot().history.loading, true);
    const pendingAgent = client.fetchTranscript('agent', 0);
    client.close();
    assert.equal(await pendingAgent, null);
    assert.equal(client.getSnapshot().history.loading, false);
  } finally {
    client.close();
  }
});
