import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { AssistantMessage, HostFrame, SessionEntry } from '@oh-my-pi/pi-wire';
import type { BrowserFrame, BrowserHostFrame, HistoryCursor } from '../shared/contracts.js';
import { SessionFeed } from '../src/session-feed.js';

const state = {cwd: '/fixture', isStreaming: false, queuedMessageCount: 0, participants: []};
function entry(id: string, content = id): SessionEntry {
  return {type: 'custom_message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', customType: 'fixture', content, display: true};
}
function message(text: string): AssistantMessage {
  return {role: 'assistant', content: [{type: 'text', text}], model: 'fixture', timestamp: 1, stopReason: 'stop',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {total: 0}}};
}
function welcome(count: number): Extract<HostFrame, {t: 'welcome'}> {
  return {t: 'welcome', proto: 3, header: {type: 'session', id: 'fixture', cwd: '/fixture', timestamp: '2026-01-01T00:00:00Z'}, state, agents: [], entryCount: count};
}
function fixture(t: TestContext, entries: SessionEntry[] = [], send: (frame: Extract<BrowserFrame, {t: 'fetch-transcript'}>) => void = () => {}) {
  const feed = new SessionFeed(send);
  t.after(() => feed.close());
  feed.accept(welcome(entries.length));
  feed.accept({t: 'snapshot-chunk', entries, final: true});
  return feed;
}
function viewer(feed: SessionFeed) {
  const frames: BrowserHostFrame[] = [];
  const reasons: string[] = [];
  const subscription = feed.subscribe({onFrame: frame => frames.push(frame), onClose: reason => reasons.push(reason)});
  const snapshot = frames.find(frame => frame.t === 'snapshot-chunk');
  const history = frames.find(frame => frame.t === 'history-state');
  assert.ok(snapshot?.t === 'snapshot-chunk');
  assert.ok(history?.t === 'history-state');
  return {frames, reasons, subscription, entries: snapshot.entries, older: history.older,
    page(cursor: HistoryCursor, reqId = 1) {
      subscription.send({t: 'history-page', reqId, cursor});
      const reply = frames.at(-1);
      assert.ok(reply?.t === 'history-page');
      assert.equal(reply.reqId, reqId);
      assert.deepEqual(reply.cursor, cursor);
      return reply.page;
    }};
}

test('warm history seeks down to zero without shifting across live appends', t => {
  const entries = Array.from({length: 245}, (_, i) => entry(String(i)));
  const feed = fixture(t, entries);
  const first = viewer(feed);
  assert.deepEqual(first.frames.slice(0, 3).map(frame => frame.t), ['welcome', 'history-state', 'snapshot-chunk']);
  assert.equal(first.frames[0]?.t === 'welcome' && first.frames[0].entryCount, 100);
  assert.equal(first.frames[0]?.t === 'welcome' && first.frames[0].readOnly, true);
  assert.deepEqual(first.entries, entries.slice(145));
  assert.ok(first.older);
  const live = {t: 'entry', entry: entry('245')} as const;
  feed.accept(live);
  assert.deepEqual(first.frames.at(-1), live);
  const middle = first.page(first.older);
  assert.deepEqual(middle.entries, entries.slice(45, 145));
  assert.ok(middle.older);
  feed.accept({t: 'state', state: {...state, isStreaming: true}});
  const oldest = first.page(middle.older);
  assert.deepEqual(oldest.entries, entries.slice(0, 45));
  assert.equal(oldest.older, null);
  assert.deepEqual(first.page({epoch: feed.epoch, before: 0}), {entries: [], older: null});
  const second = viewer(feed);
  assert.deepEqual(second.entries.map(row => row.id), [...entries.slice(146).map(row => row.id), '245']);
  first.subscription.close();
  const next = {t: 'entry', entry: entry('246')} as const;
  feed.accept(next);
  assert.deepEqual(second.frames.at(-1), next);
  assert.notDeepEqual(first.frames.at(-1), next);
});

test('snapshot entries precede interleaved live entries and deduplicate by ID', t => {
  const feed = new SessionFeed(() => {});
  t.after(() => feed.close());
  feed.accept(welcome(3));
  feed.accept({t: 'snapshot-chunk', entries: [entry('a')], final: false});
  assert.throws(() => viewer(feed), /snapshot is not ready/);
  feed.accept({t: 'entry', entry: entry('live-1')});
  feed.accept({t: 'entry', entry: entry('b', 'live duplicate must not replace snapshot')});
  feed.accept({t: 'event', event: {type: 'message_update', message: message('live partial')}});
  feed.accept({t: 'entry', entry: entry('live-2')});
  feed.accept({t: 'snapshot-chunk', entries: [entry('b'), entry('c')], final: true});
  const reader = viewer(feed);
  assert.deepEqual(reader.entries, [entry('a'), entry('b'), entry('c'), entry('live-1'), entry('live-2')]);
  assert.equal(reader.frames.at(-1)?.t, 'event');
  const before = reader.frames.length;
  feed.accept({t: 'entry', entry: entry('live-1')});
  assert.equal(reader.frames.length, before);
  feed.accept({t: 'entry', entry: entry('live-3')});
  assert.deepEqual(viewer(feed).entries.map(row => row.id), ['a', 'b', 'c', 'live-1', 'live-2', 'live-3']);
});

test('page byte budget never truncates an indivisible oversized entry or blocks older navigation', t => {
  const entries = [entry('old'), entry('huge', '😀'.repeat(90_000)), entry('new-1', 'x'.repeat(120_000)), entry('new-2', 'x'.repeat(120_000))];
  const reader = viewer(fixture(t, entries));
  assert.deepEqual(reader.entries, entries.slice(2));
  assert.ok(Buffer.byteLength(JSON.stringify(reader.entries)) < 256 * 1024);
  assert.ok(reader.older);
  const huge = reader.page(reader.older);
  assert.deepEqual(huge.entries, [entries[1]]);
  assert.ok(Buffer.byteLength(JSON.stringify(huge.entries)) > 256 * 1024);
  assert.ok(huge.older);
  const old = reader.page(huge.older);
  assert.deepEqual(old.entries, [entries[0]]);
  assert.equal(old.older, null);
});

test('warm bootstrap retains latest stream and active tools, not ended tools or old updates', t => {
  const feed = fixture(t);
  feed.accept({t: 'state', state: {...state, isStreaming: true}});
  feed.accept({t: 'event', event: {type: 'message_start', message: message('old')}});
  feed.accept({t: 'event', event: {type: 'message_update', message: message('latest')}});
  feed.accept({t: 'event', event: {type: 'tool_execution_start', toolCallId: 'active', toolName: 'read', args: {}, intent: 'inspect'}});
  feed.accept({t: 'event', event: {type: 'tool_execution_update', toolCallId: 'active', toolName: 'read', args: {}, partialResult: 'old'}});
  feed.accept({t: 'event', event: {type: 'tool_execution_update', toolCallId: 'active', toolName: 'read', args: {}, partialResult: 'latest'}});
  feed.accept({t: 'event', event: {type: 'tool_execution_start', toolCallId: 'ended', toolName: 'read', args: {}}});
  feed.accept({t: 'event', event: {type: 'tool_execution_end', toolCallId: 'ended', toolName: 'read', result: 'done'}});
  const frames = viewer(feed).frames.slice(3);
  assert.deepEqual(frames.map(frame => frame.t === 'event' ? frame.event.type : frame.t), ['state', 'message_update', 'tool_execution_start', 'tool_execution_update']);
  assert.ok(!JSON.stringify(frames).includes('old'));
  assert.ok(!JSON.stringify(frames).includes('ended'));
  feed.accept({t: 'event', event: {type: 'message_end', message: message('latest')}});
  feed.accept({t: 'entry', entry: {type: 'message', id: 'answer', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: message('latest')}});
  assert.ok(!viewer(feed).frames.some(frame => frame.t === 'event' && frame.event.type === 'message_end'));
  feed.accept({t: 'state', state});
  assert.ok(!viewer(feed).frames.some(frame => frame.t === 'event' && frame.event.type.startsWith('tool_execution')));
});

test('interruption reduces live state without replaying a stale notice over later activity', t => {
  const feed = fixture(t);
  feed.accept({t: 'event', event: {type: 'message_update', message: message('interrupted')}});
  feed.accept({t: 'event', event: {type: 'tool_execution_start', toolCallId: 'gone', toolName: 'read', args: {}}});
  feed.accept({t: 'event', event: {type: 'notice', level: 'info', source: 'collab', message: '@reader interrupted'}});
  const stopped = viewer(feed).frames;
  assert.ok(stopped.some(frame => frame.t === 'event' && frame.event.type === 'message_end' && frame.event.message.role === 'assistant' && frame.event.message.stopReason === 'aborted'));
  assert.ok(!stopped.some(frame => frame.t === 'event' && frame.event.type === 'tool_execution_start'));
  feed.accept({t: 'state', state: {...state, isStreaming: true}});
  feed.accept({t: 'event', event: {type: 'agent_start'}});
  feed.accept({t: 'event', event: {type: 'message_update', message: message('new turn')}});
  const active = viewer(feed).frames;
  assert.ok(!active.some(frame => frame.t === 'event' && frame.event.type === 'notice'));
  const last = active.at(-1);
  assert.ok(last?.t === 'event');
  assert.equal(last.event.type, 'message_update');
});

test('per-agent bus data keeps latest payload and follows the native one-frame pruning grace', t => {
  const feed = fixture(t);
  feed.accept({t: 'bus', channel: 'task:subagent:lifecycle', data: {id: 'worker', agent: 'task', status: 'started', index: 0}});
  feed.accept({t: 'bus', channel: 'task:subagent:lifecycle', data: {id: 'worker', agent: 'task', status: 'completed', index: 0}});
  feed.accept({t: 'agents', agents: []});
  const once = viewer(feed).frames.filter(frame => frame.t === 'bus');
  assert.equal(once.length, 1);
  const bus = once[0];
  assert.ok(bus?.t === 'bus');
  assert.ok(bus.data && typeof bus.data === 'object' && 'status' in bus.data);
  assert.equal(bus.data.status, 'completed');
  feed.accept({t: 'agents', agents: []});
  assert.ok(!viewer(feed).frames.some(frame => frame.t === 'bus'));
});

test('transcript IDs isolate concurrent viewers and register before a synchronous response', t => {
  const upstream: Extract<BrowserFrame, {t: 'fetch-transcript'}>[] = [];
  const feed = fixture(t, [], frame => upstream.push(frame));
  const first = viewer(feed);
  const second = viewer(feed);
  const request = {t: 'fetch-transcript', reqId: 1, agentId: 'worker', fromByte: 0} as const;
  first.subscription.send(request);
  second.subscription.send(request);
  assert.notEqual(upstream[0]!.reqId, upstream[1]!.reqId);
  feed.accept({t: 'transcript', reqId: upstream[1]!.reqId, text: 'second-private', newSize: 9});
  feed.accept({t: 'transcript', reqId: upstream[0]!.reqId, text: 'first-private', newSize: 8, error: 'Original host diagnostic'});
  assert.deepEqual(first.frames.filter(frame => frame.t === 'transcript'), [{t: 'transcript', reqId: 1, text: 'first-private', newSize: 8, error: 'Original host diagnostic'}]);
  assert.deepEqual(second.frames.filter(frame => frame.t === 'transcript'), [{t: 'transcript', reqId: 1, text: 'second-private', newSize: 9}]);
  feed.accept({t: 'transcript', reqId: upstream[0]!.reqId, text: 'late duplicate', newSize: 10});
  assert.equal(first.frames.filter(frame => frame.t === 'transcript').length, 1);
  let synchronous!: SessionFeed;
  synchronous = fixture(t, [], frame => synchronous.accept({t: 'transcript', reqId: frame.reqId, text: 'synchronous', newSize: 11}));
  const reader = viewer(synchronous);
  reader.subscription.send({...request, reqId: 73});
  assert.deepEqual(reader.frames.at(-1), {t: 'transcript', reqId: 73, text: 'synchronous', newSize: 11});
});

test('transcript timeout, viewer disposal, and send failure cannot redirect late replies', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const upstream: number[] = [];
  let fail = false;
  const feed = fixture(t, [], frame => { upstream.push(frame.reqId); if (fail) throw new Error('Original send failure'); });
  const first = viewer(feed);
  const second = viewer(feed);
  const request = {t: 'fetch-transcript', reqId: 1, agentId: 'worker', fromByte: 0} as const;
  first.subscription.send(request);
  t.mock.timers.tick(10_000);
  first.subscription.send(request);
  first.subscription.close();
  fail = true;
  assert.throws(() => second.subscription.send(request), /Original send failure/);
  fail = false;
  second.subscription.send(request);
  assert.equal(new Set(upstream).size, 4);
  for (const reqId of upstream.slice(0, 3)) feed.accept({t: 'transcript', reqId, text: 'discarded', newSize: 1});
  assert.ok(!first.frames.some(frame => frame.t === 'transcript'));
  assert.ok(!second.frames.some(frame => frame.t === 'transcript'));
  feed.accept({t: 'transcript', reqId: upstream[3]!, text: 'current', newSize: 2});
  assert.deepEqual(second.frames.at(-1), {t: 'transcript', reqId: 1, text: 'current', newSize: 2});
});

test('new feed epoch rejects old cursors and cold welcome invents no live partial', t => {
  const old = fixture(t, Array.from({length: 101}, (_, i) => entry(String(i))));
  const cursor = viewer(old).older;
  assert.ok(cursor);
  old.close('Original disconnect reason');
  const fresh = new SessionFeed(() => {});
  t.after(() => fresh.close());
  fresh.accept({...welcome(1), state: {...state, isStreaming: true}});
  fresh.accept({t: 'snapshot-chunk', entries: [entry('replacement')], final: true});
  const reader = viewer(fresh);
  assert.notEqual(fresh.epoch, old.epoch);
  assert.deepEqual(reader.frames.map(frame => frame.t), ['welcome', 'history-state', 'snapshot-chunk']);
  assert.throws(() => reader.page(cursor), /Session history changed/);
  assert.throws(() => reader.page({epoch: fresh.epoch, before: 2}), /Invalid history cursor/);
});

test('disk index is private and disposal releases files and viewers with original diagnostics', t => {
  const feed = fixture(t, [entry('sensitive')]);
  const {directory} = feed as unknown as {directory: string};
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'history.sqlite')).mode & 0o777, 0o600);
  const reader = viewer(feed);
  feed.close('Original disconnect reason');
  assert.equal(existsSync(directory), false);
  assert.deepEqual(reader.reasons, ['Original disconnect reason']);
  assert.throws(() => reader.subscription.send({t: 'history-page', reqId: 1, cursor: {epoch: feed.epoch, before: 1}}), /Original disconnect reason/);
});

test('index ingest failures dispose only the feed and preserve the storage error', t => {
  const feed = fixture(t);
  const reader = viewer(feed);
  const {db, directory} = feed as unknown as {db: DatabaseSync; directory: string};
  db.exec('DROP TABLE entries');
  assert.doesNotThrow(() => feed.accept({t: 'entry', entry: entry('cannot-index')}));
  assert.equal(reader.reasons.length, 1);
  assert.match(reader.reasons[0]!, /no such table: entries/);
  assert.equal(existsSync(directory), false);
  assert.doesNotThrow(() => feed.accept({t: 'state', state}));
  assert.throws(() => viewer(feed), /no such table: entries/);
});
