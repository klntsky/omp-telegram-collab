import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import { record } from './values.js';
interface ForkRpcDependencies {
  readonly closed: boolean;
  readonly config: AppConfig;
  readonly skillProcesses: Set<ChildProcess>;
  killSkillProcess(child: ChildProcess): void;
}

// This owner keeps the complete fork rpc transaction and its cleanup together.
export interface RuntimeForkRpc {
  forkRpc(sessionFile: string, cwd: string, config: string, command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createForkRpc(deps: ForkRpcDependencies): RuntimeForkRpc {

  async function forkRpc(sessionFile: string, cwd: string, config: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (deps.closed) throw new Error('OMP runtime is stopping');
    const child = spawn(deps.config.omp.executable, [
      ...deps.config.omp.args, '--mode', 'rpc', '--resume', sessionFile,
      '--session-dir', path.dirname(sessionFile), '--cwd', cwd, '--config', config, '--no-title',
    ], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    deps.skillProcesses.add(child);
    let buffer = '';
    let diagnostics = '';
    let failure: unknown;
    let result: Record<string, unknown> | undefined;
    let maxReassembledBytes = 64 * 1024 * 1024;
    let protocolReady = false;
    let chunks: { id: string; count: number; byteLength: number; parts: Buffer[]; received: number } | undefined;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => {
      failure ??= new Error('Native OMP fork command timed out');
      deps.killSkillProcess(child);
    }, deps.config.omp.startupTimeoutMs);
    child.once('error', error => { failure ??= error; });
    child.stdin.on('error', error => { failure ??= error; deps.killSkillProcess(child); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', part => { diagnostics += part; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      buffer += part;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          let frame: unknown = JSON.parse(line);
          if (!record(frame)) throw new Error('Native OMP emitted an invalid RPC frame');
          if (frame.type === 'rpc_chunk') {
            if (!protocolReady || typeof frame.chunkId !== 'string' || !frame.chunkId ||
                !Number.isSafeInteger(frame.index) || !Number.isSafeInteger(frame.count) ||
                !Number.isSafeInteger(frame.byteLength) || typeof frame.data !== 'string') throw new Error('Native OMP emitted an invalid RPC chunk');
            const index = frame.index as number;
            const count = frame.count as number;
            const byteLength = frame.byteLength as number;
            if (count < 1 || index < 0 || index >= count || byteLength < 1 || byteLength > maxReassembledBytes ||
                count > byteLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('Native OMP emitted an invalid RPC chunk');
            if (!chunks) {
              if (index !== 0) throw new Error('Native OMP interrupted an RPC chunk sequence');
              chunks = { id: frame.chunkId, count, byteLength, parts: [], received: 0 };
            }
            if (frame.chunkId !== chunks.id || count !== chunks.count || byteLength !== chunks.byteLength || index !== chunks.parts.length) throw new Error('Native OMP interleaved RPC chunks');
            const bytes = Buffer.from(frame.data, 'base64');
            chunks.received += bytes.length;
            if (chunks.received > byteLength) throw new Error('Native OMP RPC chunk exceeded declared size');
            chunks.parts.push(bytes);
            if (chunks.parts.length < count) continue;
            if (chunks.received !== byteLength) throw new Error('Native OMP RPC chunk size mismatch');
            frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.parts, byteLength)));
            chunks = undefined;
            if (!record(frame) || frame.type === 'rpc_chunk') throw new Error('Native OMP emitted an invalid reassembled RPC frame');
          } else if (chunks) throw new Error('Native OMP interrupted an RPC chunk sequence');
          if (frame.type === 'ready') {
            if (typeof frame.maxReassembledFrameBytes === 'number' && Number.isSafeInteger(frame.maxReassembledFrameBytes) && frame.maxReassembledFrameBytes > 0) maxReassembledBytes = Math.min(maxReassembledBytes, frame.maxReassembledFrameBytes);
            if (Array.isArray(frame.supportedProtocolVersions) && frame.supportedProtocolVersions.includes(2)) {
              child.stdin.write(`${JSON.stringify({ id: 'protocol', type: 'negotiate_protocol', protocolVersion: 2 })}\n`);
            } else child.stdin.write(`${JSON.stringify({ ...command, id: 'operation' })}\n`);
            continue;
          }
          if (frame.type === 'response' && frame.id === 'protocol') {
            if (frame.success !== true) throw new Error(typeof frame.error === 'string' ? frame.error : 'Native OMP RPC protocol negotiation failed', { cause: frame });
            protocolReady = true;
            child.stdin.write(`${JSON.stringify({ ...command, id: 'operation' })}\n`);
            continue;
          }
          if (frame.type !== 'response' || (frame.id !== 'operation' && frame.id !== 'state')) continue;
          if (frame.success !== true) throw new Error(typeof frame.error === 'string' ? frame.error : 'Native OMP fork RPC failed', { cause: frame });
          if (!record(frame.data)) throw new Error('Native OMP fork returned invalid RPC data', { cause: frame });
          if (frame.id === 'operation' && command.type === 'fork') {
            if (frame.data.cancelled !== false) throw new Error('Native OMP fork was cancelled', { cause: frame });
            child.stdin.write(`${JSON.stringify({ id: 'state', type: 'get_state' })}\n`);
          } else {
            result = frame.data;
            child.stdin.end();
          }
        } catch (error) {
          failure ??= error;
          deps.killSkillProcess(child);
        }
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        if (failure instanceof Error && diagnostics) failure.message += `\n${diagnostics}`;
        reject(failure);
      }
      else if (code !== 0 || !result) reject(Object.assign(new Error(diagnostics || 'Native OMP fork exited without a response'), { code, signal }));
      else resolve(result);
    });
    try { return await promise; }
    finally { deps.skillProcesses.delete(child); }
  }

  return { forkRpc };
}

