import type { AppConfig } from '../../shared/contracts.js';
import { SessionCapacityError, type ManagedHost, type HostActivity } from './types.js';
import { unresolvedLaunches } from './launch-record.js';
interface AdmissionDependencies {
  readonly config: AppConfig;
  readonly managed: Map<string, ManagedHost | null>;
  hostActivity(id: string): HostActivity;
  assertActive(): void;
  readonly closed: boolean;
  acquire(): Promise<void>;
  readonly reservations: Map<symbol, string>;
  readonly sessionLimit: number;
  retireIdle(idleMs?: number): Promise<number>;
}

// This owner keeps the complete admission transaction and its cleanup together.
export interface RuntimeAdmission {
  claimManaged(id: string, beforeMutation?: () => Promise<void>, reservation?: symbol): Promise<void>;
}

export function createAdmission(deps: AdmissionDependencies): RuntimeAdmission {
  let admission = Promise.resolve();
  async function occupied(): Promise<Set<string>> {
    const ids = new Set((await unresolvedLaunches(deps.config.dataDir)).keys());
    for (const id of deps.reservations.values()) ids.add(id);
    for (const [id, host] of deps.managed) if (host === null) ids.add(id);
    return ids;
  }

  async function claimManaged(id: string, beforeMutation?: () => Promise<void>, reservation?: symbol): Promise<void> {
    const previous = admission;
    const {promise,resolve} = Promise.withResolvers<void>();
    admission = promise;
    await previous;
    try {
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      await deps.acquire();
      let used = await occupied();
      await beforeMutation?.();
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (!used.has(id) && used.size >= deps.sessionLimit) {
        await deps.retireIdle(0);
        used = await occupied();
        if (!used.has(id) && used.size >= deps.sessionLimit) throw new SessionCapacityError(deps.sessionLimit);
      }
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (reservation) deps.reservations.set(reservation, id);
      else if (!used.has(id)) deps.managed.set(id,null);
      if (!reservation) deps.hostActivity(id).lastUsed = Date.now();
    } finally {
      resolve();
    }
  }

  return { claimManaged };
}

