import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { HostFrame, SessionEntry, SubagentLifecyclePayload, SubagentProgressPayload } from '@oh-my-pi/pi-wire';
import type { BrowserFrame, BrowserHostFrame, HistoryCursor, HistoryPage } from '../shared/contracts.js';
import { miniAppInterruptionAuthor } from '../shared/interruption.js';

const PAGE_ENTRIES = 100;
const PAGE_BYTES = 256 * 1024;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
type Welcome = Extract<HostFrame, {t: 'welcome'}>;
type EventFrame = Extract<HostFrame, {t: 'event'}>;
type Retained = { order: number; frame: HostFrame };
export interface SessionFeedHandlers {
  onFrame(frame: BrowserHostFrame): void;
  onClose(reason: string): void;
}
export interface SessionFeedSubscription {
  send(frame: BrowserFrame): void;
  close(): void;
}
interface Viewer { handlers: SessionFeedHandlers; requests: Set<number> }

export class SessionFeed {
  readonly epoch = randomBytes(18).toString('base64url');
  private directory: string | undefined;
  private db!: DatabaseSync;
  private insert!: StatementSync;
  private insertPending!: StatementSync;
  private readonly viewers = new Set<Viewer>();
  private readonly requests = new Map<number, {viewer: Viewer; reqId: number; timer: NodeJS.Timeout}>();
  private nextRequest = 1;
  private nextOrdinal = 0;
  private ready = false;
  private ended: string | undefined;
  private welcome: Welcome | undefined;
  private order = 0;
  private state: Retained | undefined;
  private agents: Retained | undefined;
  private working: Retained | undefined;
  private stream: Retained | undefined;
  private streamDone = false;
  private readonly tools = new Map<string, {start?: Retained; update?: Retained}>();
  private readonly bus = new Map<string, Retained>();
  private unlisted = new Set<string>();

  constructor(private readonly sendUpstream: (frame: Extract<BrowserFrame, {t: 'fetch-transcript'}>) => void) {
    try {
      this.directory = mkdtempSync(join(tmpdir(), 'omp-session-feed-'));
      this.db = new DatabaseSync(join(this.directory, 'history.sqlite'));
      chmodSync(join(this.directory, 'history.sqlite'), 0o600);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;
        CREATE TABLE entries (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE pending (arrival INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, payload TEXT NOT NULL);`);
      this.insert = this.db.prepare('INSERT OR IGNORE INTO entries VALUES (?,?,?,?)');
      this.insertPending = this.db.prepare('INSERT OR IGNORE INTO pending (id,bytes,payload) VALUES (?,?,?)');
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
    }
  }

  accept(frame: HostFrame): void {
    if (this.ended !== undefined) return;
    try {
      if (frame.t === 'transcript') {
        const pending = this.requests.get(frame.reqId);
        if (pending) {
          this.cancelRequest(frame.reqId);
          pending.viewer.handlers.onFrame({...frame, reqId: pending.reqId});
        }
        return;
      }
      if (frame.t === 'welcome') {
        this.welcome = frame;
        return;
      }
      if (frame.t === 'snapshot-chunk') {
        this.db.exec('BEGIN');
        try {
          for (const entry of frame.entries) this.append(entry);
          if (frame.final) {
            const appended = this.db.prepare(`INSERT INTO entries (ordinal,id,bytes,payload)
              SELECT ? + row_number() OVER (ORDER BY arrival) - 1,id,bytes,payload FROM pending
              WHERE NOT EXISTS (SELECT 1 FROM entries WHERE entries.id=pending.id) ORDER BY arrival`).run(this.nextOrdinal);
            this.nextOrdinal += Number(appended.changes);
            this.db.exec('DELETE FROM pending');
          }
          this.db.exec('COMMIT');
        } catch (error) {
          try { this.db.exec('ROLLBACK'); }
          catch (rollbackError) { console.warn('Could not roll back session history index', rollbackError); }
          throw error;
        }
        if (frame.final) this.ready = true;
        return;
      }
      if (frame.t === 'entry') {
        if (this.ready) {
          if (!this.append(frame.entry)) {
            this.retain(frame);
            return;
          }
        } else {
          const payload = JSON.stringify(frame.entry);
          this.insertPending.run(frame.entry.id, Buffer.byteLength(payload), payload);
        }
      }
      this.retain(frame);
      if (this.ready) for (const viewer of this.viewers) viewer.handlers.onFrame(frame);
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
    }
  }

  private append(entry: SessionEntry): boolean {
    const payload = JSON.stringify(entry);
    const result = this.insert.run(this.nextOrdinal, entry.id, Buffer.byteLength(payload), payload);
    if (!result.changes) return false;
    this.nextOrdinal++;
    return true;
  }

  private page(before: number): HistoryPage {
    try {
      const rows = this.db.prepare('SELECT ordinal,bytes FROM entries WHERE ordinal < ? ORDER BY ordinal DESC LIMIT ?')
        .all(before, PAGE_ENTRIES);
      const entries: SessionEntry[] = [];
      let bytes = 512;
      let first = before;
      const payload = this.db.prepare('SELECT payload FROM entries WHERE ordinal=?');
      for (const row of rows) {
        const size = Number(row.bytes) + (entries.length ? 1 : 0);
        if (entries.length && bytes + size > PAGE_BYTES) break;
        entries.push(JSON.parse(String(payload.get(row.ordinal!)!.payload)) as SessionEntry);
        bytes += size;
        first = Number(row.ordinal);
      }
      entries.reverse();
      return {entries, older: first > 0 ? {epoch: this.epoch, before: first} : null};
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  subscribe(handlers: SessionFeedHandlers): SessionFeedSubscription {
    if (this.ended !== undefined) throw new Error(this.ended);
    if (!this.ready || !this.welcome) throw new Error('Collab snapshot is not ready');
    const page = this.page(this.nextOrdinal);
    const retained = [this.state, this.agents, this.working, this.stream,
      ...Array.from(this.tools.values()).flatMap(tool => [tool.start, tool.update]), ...this.bus.values()]
      .filter((value): value is Retained => value !== undefined).sort((a,b) => a.order-b.order);
    const viewer: Viewer = {handlers, requests: new Set()};
    handlers.onFrame({...this.welcome, entryCount: page.entries.length, readOnly: true});
    handlers.onFrame({t: 'history-state', older: page.older});
    handlers.onFrame({t: 'snapshot-chunk', entries: page.entries, final: true});
    for (const value of retained) handlers.onFrame(value.frame);
    this.viewers.add(viewer);
    return {
      send: frame => {
        if (!this.viewers.has(viewer)) throw new Error(this.ended ?? 'Session not connected');
        if (frame.t === 'history-page') {
          this.validateCursor(frame.cursor);
          handlers.onFrame({t: 'history-page', reqId: frame.reqId, cursor: frame.cursor, page: this.page(frame.cursor.before)});
          return;
        }
        if (!Number.isSafeInteger(this.nextRequest)) throw new Error('Transcript request IDs exhausted');
        const reqId = this.nextRequest++;
        const timer = setTimeout(() => this.cancelRequest(reqId), TRANSCRIPT_TIMEOUT_MS);
        timer.unref();
        this.requests.set(reqId, {viewer, reqId: frame.reqId, timer});
        viewer.requests.add(reqId);
        try { this.sendUpstream({...frame, reqId}); }
        catch (error) { this.cancelRequest(reqId); throw error; }
      },
      close: () => {
        this.viewers.delete(viewer);
        for (const reqId of viewer.requests) this.cancelRequest(reqId);
      },
    };
  }

  private validateCursor(cursor: HistoryCursor): void {
    if (cursor.epoch !== this.epoch) throw new Error('Session history changed; reconnect to load it again');
    if (!Number.isSafeInteger(cursor.before) || cursor.before < 0 || cursor.before > this.nextOrdinal)
      throw new Error('Invalid history cursor');
  }

  private cancelRequest(reqId: number): void {
    const pending = this.requests.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.viewer.requests.delete(reqId);
    this.requests.delete(reqId);
  }

  close(reason = 'Host disconnected'): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    for (const reqId of this.requests.keys()) this.cancelRequest(reqId);
    const viewers = [...this.viewers];
    this.viewers.clear();
    try { this.db?.close(); }
    catch (error) { console.warn('Could not close session history index', error); }
    try { if (this.directory) rmSync(this.directory, {recursive: true, force: true}); }
    catch (error) { console.warn('Could not remove session history index', error); }
    for (const viewer of viewers) {
      try { viewer.handlers.onClose(reason); }
      catch (error) { console.warn('Could not close session feed viewer', error); }
    }
    this.tools.clear();
    this.bus.clear();
    this.unlisted.clear();
    this.welcome = undefined;
    this.state = this.agents = this.working = this.stream = undefined;
  }

  private retain(frame: HostFrame): void {
    const value = {order: ++this.order, frame};
    if (frame.t === 'state') {
      this.state = value;
      if (!frame.state.isStreaming) {
        this.tools.clear();
        if (this.streamDone) { this.stream = undefined; this.streamDone = false; }
      }
    } else if (frame.t === 'agents') {
      this.agents = value;
      const listed = new Set(frame.agents.map(agent => agent.id));
      const missing = new Set<string>();
      for (const [key, retained] of this.bus) {
        const id = this.busId(retained.frame as Extract<HostFrame, {t: 'bus'}>);
        if (!listed.has(id)) {
          if (this.unlisted.has(id)) this.bus.delete(key);
          else missing.add(id);
        }
      }
      this.unlisted = missing;
    } else if (frame.t === 'bus') {
      this.bus.set(`${frame.channel}:${this.busId(frame)}`, value);
    } else if (frame.t === 'entry') {
      if (this.streamDone && frame.entry.type === 'message' && frame.entry.message.role === 'assistant') {
        this.stream = undefined;
        this.streamDone = false;
      }
    } else if (frame.t === 'event') {
      const event = frame.event;
      switch (event.type) {
        case 'message_start': case 'message_update': case 'message_end':
          if (event.message.role === 'assistant') {
            this.stream = value;
            this.streamDone = event.type === 'message_end';
          }
          break;
        case 'tool_execution_start': this.tools.set(event.toolCallId, {start: value}); break;
        case 'tool_execution_update': {
          const tool = this.tools.get(event.toolCallId) ?? {};
          tool.update = value;
          this.tools.set(event.toolCallId, tool);
          break;
        }
        case 'tool_execution_end': this.tools.delete(event.toolCallId); break;
        case 'agent_start': case 'agent_end': this.working = value; break;
        case 'notice':
          if (miniAppInterruptionAuthor(event)) {
            this.tools.clear();
            this.working = {order: value.order, frame: {t: 'event', event: {type: 'agent_end'}}};
            const state = this.state?.frame.t === 'state' ? this.state.frame.state : this.welcome?.state;
            if (state) this.state = {order: value.order, frame: {t: 'state', state: {...state, isStreaming: false, isAborting: false, queuedMessageCount: 0}}};
            if (this.stream && !this.streamDone) {
              const stream = this.stream.frame as EventFrame;
              if ((stream.event.type === 'message_start' || stream.event.type === 'message_update' ||
                   stream.event.type === 'message_end') && stream.event.message.role === 'assistant') {
                this.stream = {order: value.order, frame: {t: 'event', event: {type: 'message_end', message: {...stream.event.message, stopReason: 'aborted'}}}};
                this.streamDone = true;
              }
            }
          }
          break;
      }
    }
  }

  private busId(frame: Extract<HostFrame, {t: 'bus'}>): string {
    return frame.channel === 'task:subagent:progress'
      ? (frame.data as SubagentProgressPayload).progress.id
      : (frame.data as SubagentLifecyclePayload).id;
  }
}
