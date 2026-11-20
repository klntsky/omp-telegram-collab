import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { CustomMessageEntry } from '@oh-my-pi/pi-wire';
import type { HistorySource } from './history-watch.js';

// Resolve synchronously so later frames cannot overtake receipt routing. Normal appends
// precede notification, but fenced atomic rewrites can defer persistence; missing entries
// deliberately fail rather than introducing waiting or receipt recovery state.
// https://github.com/can1357/oh-my-pi/blob/v16.3.6/packages/coding-agent/src/session/session-manager.ts
export function readPromptReceipt(source: HistorySource, entryId: string): CustomMessageEntry {
  const fd = openSync(source.path, 'r');
  let failed = false;
  let failure: unknown;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let first = true;
    let headerRead = false;
    const consume = (line: string): CustomMessageEntry | undefined => {
      const entry = JSON.parse(line) as Record<string, unknown> | null;
      if (first) {
        first = false;
        if (entry?.type === 'title' && entry.v === 1) return;
      }
      if (!headerRead) {
        if (entry?.type !== 'session' || entry.version !== 3 || entry.id !== source.sessionId) {
          throw new Error(`Prompt receipt history header does not match session ${source.sessionId}`);
        }
        headerRead = true;
        return;
      }
      if (entry?.id !== entryId) return;
      if (entry.type !== 'custom_message' || entry.customType !== 'collab-prompt') {
        throw new Error(`History entry ${entryId} is not a collab-prompt custom_message`);
      }
      return entry as unknown as CustomMessageEntry;
    };
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      pending += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
      let start = 0;
      let end: number;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        const receipt = consume(pending.slice(start, end));
        if (receipt) return receipt;
        start = end + 1;
      }
      pending = pending.slice(start);
      if (bytesRead) continue;
      if (pending) {
        const receipt = consume(pending);
        if (receipt) return receipt;
      }
      if (!headerRead) throw new Error(`Missing prompt receipt history header for session ${source.sessionId}`);
      throw new Error(`Prompt receipt entry ${entryId} not found in session ${source.sessionId}`);
    }
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try { closeSync(fd); }
    catch (error) {
      if (!failed) throw error;
      throw new AggregateError([failure, error], [
        failure instanceof Error ? failure.message : String(failure),
        `Closing prompt receipt history failed: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'), { cause: failure });
    }
  }
}
