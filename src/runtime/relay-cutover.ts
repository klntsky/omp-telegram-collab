import path from 'node:path';
import type { HostBinding, TopicSession } from '../../shared/contracts.js';
import type { DurableBinding, HostLifecycle, ManagedHost } from './types.js';
import { managedLifecycleIdentity, usesManagedRelay } from './lifecycle-identity.js';

interface CutoverDependencies {
  dataDir: string;
  relayUrl(): Promise<string>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  managed: Map<string, ManagedHost | null>;
  pending: Map<string, Promise<HostBinding>>;
  stopHost(id: string, guard: 'idle'): Promise<void>;
}

export interface RuntimeRelayCutover {
  prepare(sessions: TopicSession[]): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export function createRelayCutover(deps: CutoverDependencies): RuntimeRelayCutover {
  const waiting = new Map<string, TopicSession>();
  let draining: Promise<void> | undefined;
  function drain(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      if (!waiting.size) return;
      const url = await deps.relayUrl();
      for (const [id, session] of waiting) {
        if (deps.pending.has(id)) continue;
        try {
          if (await usesManagedRelay(path.join(deps.dataDir, 'sessions', id), url)) { waiting.delete(id); continue; }
          const lifecycle = await deps.lifecycle(id);
          if (!lifecycle) { waiting.delete(id); continue; }
          const pin = await deps.readManagedBinding(session);
          if (!pin) { waiting.delete(id); continue; }
          const host = deps.managed.get(id) ?? { sessionId: pin.sessionId, cwd: pin.cwd, exited: false, retiring: false };
          const identity = await managedLifecycleIdentity(deps.dataDir, id, host, lifecycle);
          if (!identity) { waiting.delete(id); continue; }
          if (deps.pending.has(id)) continue;
          host.identity = { pid: lifecycle.pid, start: identity.start };
          deps.managed.set(id, host);
          // Configuration cutover is a local operator operation, not a Telegram
          // prompt. Retire only when the host itself confirms it has no active or
          // pending work; preserve the pinned history and leave restart to admission.
          await deps.stopHost(id, 'idle');
          if (host.exited) waiting.delete(id);
        } catch (error) {
          console.error('Managed local relay cutover failed.', error, { sessionId: id });
        }
      }
    })().finally(() => { draining = undefined; });
    return draining;
  }
  return {
    async prepare(sessions: TopicSession[]): Promise<void> {
      for (const session of sessions) if (session.runtime.kind === 'managed') waiting.set(session.id, session);
      await drain();
    },
    drain,
    async close(): Promise<void> { waiting.clear(); await draining; },
  };
}
