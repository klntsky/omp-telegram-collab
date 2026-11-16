import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bounded } from './async.js';

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Prepared = { sourceId: string; destinationId: string };

export async function startCollaborationProcess(
  t: Pick<TestContext, 'after' | 'signal'>,
  options: {
    configPath: string;
    topicActivityEmojis: { running: string; finished: string };
    log: (event: string, data: unknown) => void;
  },
): Promise<{ forkPrepared: Promise<Prepared>; kill(): Promise<Exit> }> {
  t.signal.throwIfAborted();
  const child = spawn(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('./application-worker.ts', import.meta.url)),
    options.configPath, JSON.stringify(options.topicActivityEmojis),
  ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<Prepared>();
  const exited = Promise.withResolvers<Exit>();
  let closed = false;
  let killed = false;
  let workerFailure: Error | undefined;
  void ready.promise.catch(() => undefined);
  void prepared.promise.catch(() => undefined);
  function fail(error: Error): void {
    workerFailure ??= error;
    ready.reject(error);
    prepared.reject(error);
  }
  child.stdout!.on('data', (data: Buffer) => options.log('application.worker.stdout', data.toString()));
  child.stderr!.on('data', (data: Buffer) => options.log('application.worker.stderr', data.toString()));
  child.on('error', fail);
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return;
    options.log('application.worker.message', message);
    if (message.type === 'ready') ready.resolve();
    if (message.type === 'forkPrepared' && 'sourceId' in message && 'destinationId' in message &&
      typeof message.sourceId === 'string' && typeof message.destinationId === 'string') {
      prepared.resolve({ sourceId: message.sourceId, destinationId: message.destinationId });
    }
    if (message.type === 'failure' && 'diagnostic' in message) {
      fail(new Error(String(message.diagnostic)));
    }
  });
  child.on('close', (code, signal) => {
    closed = true;
    if (!killed) fail(new Error(`Application worker exited unexpectedly (${code ?? signal})`));
    exited.resolve({ code, signal });
  });
  async function kill(): Promise<Exit> {
    if (!closed) {
      killed = true;
      child.kill('SIGKILL');
    }
    const result = await bounded(exited.promise, AbortSignal.timeout(30_000));
    if (workerFailure) throw workerFailure;
    return result;
  }
  const cancel = () => {
    if (!closed) {
      killed = true;
      child.kill('SIGKILL');
    }
    const error = t.signal.reason instanceof Error ? t.signal.reason : new Error('Application worker cancelled');
    ready.reject(error);
    prepared.reject(error);
  };
  t.signal.addEventListener('abort', cancel, { once: true });
  t.after(async () => {
    t.signal.removeEventListener('abort', cancel);
    await kill();
  });
  try {
    await bounded(ready.promise, AbortSignal.any([t.signal, AbortSignal.timeout(120_000)]));
  } catch (error) {
    try { await kill(); } catch (cleanupError) {
      if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'Application worker setup failed');
    }
    throw error;
  }
  const forkPrepared = bounded(prepared.promise, AbortSignal.any([t.signal, AbortSignal.timeout(120_000)]));
  void forkPrepared.catch(() => undefined);
  return { forkPrepared, kill };
}
