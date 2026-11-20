import { open, stat } from 'node:fs/promises';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import type { HistorySource } from '../history-watch.js';
import { readHistoryHeader } from '../history-watch.js';
import { record } from '../runtime/values.js';

/** Read only committed JSONL records; never resume a session or acquire its writer lease. */
export async function readReplyHistory(source: HistorySource): Promise<SessionEntry[]> {
  const file = await open(source.path, 'r');
  let failure: unknown;
  try {
    const initial = await file.stat({ bigint: true });
    if ((await readHistoryHeader(file)).id !== source.sessionId) throw new Error('OMP reply history identity changed');
    const entries: SessionEntry[] = [];
    const accept = (line: string) => {
      const value: unknown = JSON.parse(line);
      if (!record(value) || !['message', 'custom_message'].includes(String(value.type))) return;
      if (typeof value.id !== 'string' || !(value.parentId === null || typeof value.parentId === 'string')) throw new Error('Invalid OMP reply history entry');
      if (value.type === 'message' && (!record(value.message) || value.message.role !== 'assistant')) return;
      if (value.type === 'custom_message' && value.customType !== 'collab-prompt') return;
      entries.push(value as unknown as SessionEntry);
    };
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, Number(initial.size) - 1);
    // The writer can be appending concurrently. Freeze the read boundary and leave
    // a non-newline-terminated record for the next recovery rather than parsing it.
    let previous: string | undefined;
    for await (const line of file.readLines({ start: 0, end: Number(initial.size) - 1, autoClose: false })) {
      if (previous !== undefined) accept(previous);
      previous = line;
    }
    if (last[0] === 10 && previous !== undefined) accept(previous);
    const current = await stat(source.path, { bigint: true });
    if (initial.dev !== current.dev || initial.ino !== current.ino || current.size < initial.size ||
        (current.size === initial.size && current.mtimeNs !== initial.mtimeNs)) throw new Error('OMP reply history changed during recovery');
    return entries;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await file.close(); }
    catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], `${failure instanceof Error ? failure.message : String(failure)}\n${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
