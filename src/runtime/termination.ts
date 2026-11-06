import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type DurableBinding, type ManagedHost } from './types.js';
interface TerminationDependencies {
  readonly config: AppConfig;
  readonly managed: Map<string, ManagedHost | null>;
  readonly stopping: Map<string, Promise<void>>;
  readonly pending: Map<string, Promise<HostBinding>>;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void>;
  readonly closed: boolean;
  readonly killing: Map<string, Promise<void>>;
  acquire(): Promise<void>;
  killSession(session: TopicSession): Promise<void>;
}

// This owner keeps the complete termination transaction and its cleanup together.
export interface RuntimeTermination {
  stop(session: TopicSession): Promise<boolean>;
  stopHost(id: string, guard?: 'idle' | 'worktree', session?: TopicSession): Promise<void>;
  kill(session: TopicSession): Promise<void>;
}

export function createTermination(deps: TerminationDependencies): RuntimeTermination {

  function stop(session: TopicSession): Promise<boolean> {
    if (session.runtime.kind === 'attached') return Promise.resolve(true);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return Promise.reject(new Error('Invalid managed session identifier'));
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) return Promise.reject(new Error('Instance path is not configured'));
    return stopHost(session.id, undefined, session).then(() => {
      const host = deps.managed.get(session.id);
      return !host || host.exited;
    });
  }

  function stopHost(id: string, guard?: 'idle' | 'worktree', session?: TopicSession): Promise<void> {
    const pending = deps.stopping.get(id);
    if (pending) return session ? pending.then(() => stopHost(id, guard, session)) : pending;
    const operation = (async () => {
      await deps.pending.get(id)?.catch(() => undefined);
      let host = deps.managed.get(id);
      if (session) {
        const pin = await deps.readManagedBinding(session);
        if (!pin) return;
        host ??= { sessionId: pin.sessionId, cwd: pin.cwd, exited: false, retiring: false };
        host.cwd = pin.cwd;
        deps.managed.set(id, host);
      }
      if (host) await deps.shutdown(id,host,guard);
    })().finally(() => {
      if (deps.stopping.get(id) === operation) deps.stopping.delete(id);
    });
    deps.stopping.set(id, operation);
    return operation;
  }

  function kill(session: TopicSession): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return Promise.reject(new Error('Invalid managed session identifier'));
    if (deps.closed) return Promise.reject(new Error('OMP runtime is stopping'));
    const pending = deps.killing.get(session.id);
    if (pending) return pending;
    const ids = new Set([session.id]);
    const sessionId = session.runtime.kind === 'attached' ? session.runtime.sessionId : deps.managed.get(session.id)?.sessionId;
    if (sessionId) {
      for (const [id, host] of deps.managed) {
        if (host?.sessionId === sessionId) ids.add(id);
      }
    }
    const operation = Promise.resolve().then(async () => {
      await Promise.allSettled([...ids].map(id => deps.pending.get(id)));
      await deps.acquire();
      await deps.killSession(session);
    }).finally(() => {
      for (const id of ids) {
        if (deps.killing.get(id) === operation) deps.killing.delete(id);
        if (deps.stopping.get(id) === operation) deps.stopping.delete(id);
      }
    });
    for (const id of ids) {
      deps.killing.set(id, operation);
      deps.stopping.set(id, operation);
    }
    return operation;
  }

  return { stop, stopHost, kill };
}

