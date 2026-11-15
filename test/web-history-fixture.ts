import assert from 'node:assert/strict';
import type { AssistantMessage, SessionEntry } from '@oh-my-pi/pi-wire';
import type { BrowserFrame, BrowserHostFrame, HistoryCursor } from '../shared/contracts.js';
import type { GuestTransport } from '../web/src/lib/socket.js';

export class Transport implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: BrowserHostFrame) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: BrowserFrame[] = [];
  connections = 0;
  reconnects = 0;
  closes = 0;
  connect(): void { this.connections++; this.onOpen?.(); }
  reconnect(reason: string): void { this.reconnects++; this.onClose?.(reason, true); }
  close(): void { this.closes++; this.onClose?.('Closed', false); }
  send(frame: BrowserFrame): void { this.sent.push(frame); }
  receive(frame: BrowserHostFrame): void { this.onFrame?.(frame); }
  historyRequest(): Extract<BrowserFrame, {t: 'history-page'}> {
    const request = this.sent.findLast(frame => frame.t === 'history-page');
    assert.ok(request?.t === 'history-page');
    return request;
  }
}

export const timestamp = '2026-01-01T00:00:00.000Z';
export function entry(id: string, content = id): SessionEntry {
  return {type: 'message', id, parentId: null, timestamp, message: {role: 'user', content, timestamp: 0}};
}
export function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: [{type: 'text', text}], model: 'fixture', timestamp: 0, stopReason: 'stop',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {total: 0}},
  };
}
export function welcome(transport: Transport, count: number): void {
  transport.receive({
    t: 'welcome', proto: 2, readOnly: true, entryCount: count,
    header: {type: 'session', id: 'session', cwd: '/work', timestamp},
    state: {isStreaming: false, queuedMessageCount: 0, cwd: '/work', participants: []}, agents: [],
  });
}
export function ready(transport: Transport, entries: SessionEntry[], older: HistoryCursor | null): void {
  welcome(transport, entries.length);
  transport.receive({t: 'history-state', older});
  transport.receive({t: 'snapshot-chunk', entries, final: true});
}
