import { execFile } from 'node:child_process';
import type { AppConfig } from '../../shared/contracts.js';
import { childEnvironment } from './environment.js';

type Snapshot = Record<string, unknown>;
interface Request {
  readonly deadline: number;
  readonly resolve: (value: Snapshot) => void;
  readonly reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
}
interface Batch {
  readonly args: string[];
  readonly requests: Set<Request>;
}

const maxRequests = 128;
export class DiscoveryTimeoutError extends Error {
  constructor() {
    super('OMP discovery timed out');
    this.name = 'DiscoveryTimeoutError';
  }
}

export function isDiscoveryDeadlineError(error: unknown): error is Error {
  return error instanceof DiscoveryTimeoutError ||
    (error instanceof Error && 'killed' in error && error.killed === true &&
      'code' in error && error.code === null && 'signal' in error && error.signal === 'SIGKILL');
}

const timedOut = () => new DiscoveryTimeoutError();

export function createDiscovery(config: Pick<AppConfig, 'omp' | 'dataDir'>) {
  const queue: Batch[] = [];
  let active: Batch | undefined;
  let requests = 0;

  function finish(batch: Batch, request: Request, error: unknown, value?: Snapshot): void {
    if (!batch.requests.delete(request)) return;
    clearTimeout(request.timer);
    requests--;
    if (error !== undefined) request.reject(error);
    else request.resolve(value!);
    if (batch !== active && batch.requests.size === 0) {
      const index = queue.indexOf(batch);
      if (index !== -1) queue.splice(index, 1);
    }
  }

  function drain(): void {
    if (active) return;
    const batch = queue.shift();
    if (!batch) return;
    const now = Date.now();
    let deadline = 0;
    for (const request of batch.requests) {
      if (request.deadline <= now) finish(batch, request, timedOut());
      else deadline = Math.max(deadline, request.deadline);
    }
    if (batch.requests.size === 0) {
      drain();
      return;
    }
    active = batch;
    for (const request of batch.requests) {
      if (request.deadline === deadline) clearTimeout(request.timer);
    }
    // Earlier callers may expire independently. The latest-deadline callers own
    // the subprocess until its callback, retaining the original kill/exit error
    // even when process cleanup finishes after their deadline.
    const complete = (error: unknown, stdout = '') => {
      let failure: unknown = error ?? undefined;
      let value: Snapshot | undefined;
      if (!error) {
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
          value = parsed as Snapshot;
        } catch (cause) {
          failure = new Error(`OMP discovery returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
      }
      if (failure !== undefined) {
        console.error('OMP discovery subprocess failed', {
          executable: config.omp.executable, args: batch.args, cwd: config.dataDir,
        }, failure);
      }
      const completed = Date.now();
      for (const request of batch.requests) {
        finish(batch, request, failure ?? (completed >= request.deadline ? timedOut() : undefined), value);
      }
      active = undefined;
      drain();
    };
    try {
      const env = childEnvironment();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        for (const request of batch.requests) finish(batch, request, timedOut());
        active = undefined;
        drain();
        return;
      }
      execFile(config.omp.executable, batch.args, {
        cwd: config.dataDir,
        env,
        timeout: remaining,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      }, complete);
    } catch (error) {
      complete(error);
    }
  }

  function enqueue(args: string[], deadline: number): Promise<Snapshot> {
    if (deadline <= Date.now()) return Promise.reject(timedOut());
    if (requests >= maxRequests) return Promise.reject(new Error('OMP discovery queue is full'));
    const { promise, resolve, reject } = Promise.withResolvers<Snapshot>();
    const tail = queue.at(-1);
    // Only queued lists share a snapshot. Joining an active list could return
    // pre-link identity to a post-link check, hiding a changed host generation.
    const batch = args[1] === 'list' && tail?.args[1] === 'list'
      ? tail : { args, requests: new Set<Request>() };
    if (batch !== tail) queue.push(batch);
    const request: Request = { deadline, resolve, reject };
    batch.requests.add(request);
    requests++;
    request.timer = setTimeout(() => finish(batch, request, timedOut()), Math.max(1, deadline - Date.now()));
    drain();
    return promise;
  }

  return {
    list: (deadline: number) => enqueue(['collab', 'list', '--json'], deadline),
    link: (instanceId: string, deadline: number) => enqueue(['collab', 'link', instanceId, '--json'], deadline),
  };
}
