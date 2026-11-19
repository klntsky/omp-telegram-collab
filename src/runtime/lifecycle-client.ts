import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostLifecycle } from './types.js';
import { record } from './values.js';

interface LifecycleRequest {
  type: 'status' | 'retire' | 'model_presets' | 'list_skills' | 'set_session_title';
  requestId: string;
  deadline: number;
  sessionId?: string;
  pid?: number;
  name?: string;
  guard?: 'idle' | 'none';
  acknowledgedSessionFile?: string;
}

export async function requestLifecycle(host: HostLifecycle, request: LifecycleRequest): Promise<Record<string, unknown>> {
  const filename = host.socketPath;
  if (path.dirname(filename) !== tmpdir() || !/^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(filename))) throw new Error('Invalid OMP lifecycle socket');
  const stat = await lstat(filename);
  if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('OMP lifecycle control must use private owner-only sockets');
  const encoded = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(encoded) > 16384) throw new Error('OMP lifecycle request is too large');
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const socket = createConnection(filename);
  let input = '';
  let settled = false;
  const finish = (error?: unknown, value?: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (error !== undefined) reject(error); else resolve(value!);
  };
  const timer = setTimeout(() => finish(new Error('OMP lifecycle request timed out')), Math.max(1, request.deadline - Date.now()));
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(encoded));
  socket.once('error', finish);
  socket.once('end', () => finish(new Error('OMP lifecycle control closed without a response')));
  socket.once('close', () => finish(new Error('OMP lifecycle control disconnected without a response')));
  socket.on('data', part => {
    input += part;
    if (Buffer.byteLength(input) > 262144) { finish(new Error('OMP lifecycle response is too large')); return; }
    if (!input.includes('\n')) return;
    try {
      const value: unknown = JSON.parse(input.trim());
      if (!record(value) || value.requestId !== request.requestId || value.pid !== host.pid ||
          (request.sessionId !== undefined && value.sessionId !== request.sessionId)) throw new Error('OMP lifecycle response identity changed');
      finish(undefined, value);
    } catch (error) { finish(error); }
  });
  return promise;
}
