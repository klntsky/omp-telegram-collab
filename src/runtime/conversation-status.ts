import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostLifecycle } from './types.js';
import { record } from './values.js';

export interface ConversationStatus {
  pid: number;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  candidate?: { sessionId: string; sessionFile: string; cwd: string; sequence: number; reason: string; previousSessionFile?: string; previousSessionFiles: string[] };
}
export async function conversationStatus(lifecycle: HostLifecycle, acknowledgedSessionFile: string): Promise<ConversationStatus> {
  if (path.dirname(lifecycle.socketPath) !== tmpdir() || !/^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(lifecycle.socketPath))) {
    throw new Error('Invalid OMP conversation control descriptor');
  }
  const stat = await lstat(lifecycle.socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('OMP conversation control must use private owner-only sockets');
  }
  const requestId = randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers<ConversationStatus>();
  const socket = createConnection(lifecycle.socketPath);
    let input = '';
    let settled = false;
    const finish = (error?: unknown, status?: ConversationStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error); else resolve(status!);
    };
    const timer = setTimeout(() => finish(new Error('OMP conversation status timed out')), 2000);
    socket.setEncoding('utf8');
    socket.once('error', finish);
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'status', requestId, acknowledgedSessionFile, deadline: Date.now() + 2000 })}\n`));
    socket.once('end', () => finish(new Error('OMP conversation status closed without a response')));
    socket.once('close', () => finish(new Error('OMP conversation status disconnected without a response')));
    socket.on('data', part => {
      input += part;
      if (Buffer.byteLength(input) > 262144) { finish(new Error('OMP conversation status is too large')); return; }
      if (!input.includes('\n')) return;
      try {
        const value: unknown = JSON.parse(input.trim());
        if (!record(value) || value.requestId !== requestId || value.pid !== lifecycle.pid) throw new Error('OMP conversation status identity changed');
        if (typeof value.error === 'string') throw new Error(value.error);
        if (typeof value.sessionId !== 'string' || typeof value.sessionFile !== 'string' || typeof value.cwd !== 'string' ||
            !path.isAbsolute(value.sessionFile) || !path.isAbsolute(value.cwd)) throw new Error('Invalid OMP conversation status');
        if (value.candidate !== undefined) {
          const candidate = value.candidate;
          if (!record(candidate) || typeof candidate.sessionId !== 'string' || typeof candidate.sessionFile !== 'string' ||
              typeof candidate.cwd !== 'string' || !Number.isSafeInteger(candidate.sequence) || typeof candidate.reason !== 'string' ||
              !Array.isArray(candidate.previousSessionFiles) || !candidate.previousSessionFiles.every(file => typeof file === 'string') ||
              (candidate.previousSessionFile !== undefined && typeof candidate.previousSessionFile !== 'string')) throw new Error('Invalid OMP conversation transition');
        }
        finish(undefined, value as unknown as ConversationStatus);
      } catch (error) { finish(error); }
    });
  return promise;
}
