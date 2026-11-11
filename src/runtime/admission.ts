import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding } from '../../shared/contracts.js';
import { SessionCapacityError, type RegistryHost, type DurableBinding, type ManagedHost, type HostActivity, type HostLifecycle } from './types.js';
import { procIdentity } from './process.js';
import { errno } from './values.js';
interface AdmissionDependencies {
  readonly config: AppConfig;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  readonly managed: Map<string, ManagedHost | null>;
  hostActivity(id: string): HostActivity;
  assertActive(): void;
  readonly closed: boolean;
  acquire(): Promise<void>;
  list(deadline: number): Promise<RegistryHost[]>;
  readonly pending: Map<string, Promise<HostBinding>>;
  forgetActivity(id: string): void;
  readonly reservations: Map<symbol, string>;
  capacityUsed(): number;
  readonly sessionLimit: number;
  retireIdle(idleMs?: number): Promise<number>;
}

// This owner keeps the complete admission transaction and its cleanup together.
export interface RuntimeAdmission {
  claimManaged(id: string, beforeMutation?: () => Promise<void>, reservation?: symbol): Promise<void>;
}

export function createAdmission(deps: AdmissionDependencies): RuntimeAdmission {
  let admission = Promise.resolve();
  let discovered = false;
  async function discoverManaged(hosts: RegistryHost[]): Promise<void> {
    if (discovered) return;
    const root = path.join(deps.config.dataDir,'sessions');
    let entries;
    try { entries = await readdir(root,{withFileTypes:true}); }
    catch (error) {
      if (errno(error,'ENOENT')) { discovered = true; return; }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
      let pin: DurableBinding;
      try { pin = JSON.parse(await readFile(path.join(root,entry.name,'binding.json'),'utf8')) as DurableBinding; }
      catch (error) { if (errno(error,'ENOENT')) continue; throw error; }
      const host = hosts.find(value => value.sessionId === pin.sessionId && value.cwd === pin.cwd);
      if (!host) continue;
      const lifecycle = await deps.lifecycle(entry.name);
      deps.managed.set(entry.name,{sessionId:pin.sessionId,exited:false,retiring:lifecycle?.retiring===true});
      deps.hostActivity(entry.name).busy = host.busy !== false;
    }
    discovered = true;
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
      const hosts = await deps.list(Date.now()+deps.config.omp.startupTimeoutMs);
      await discoverManaged(hosts);
      for (const [other,host] of deps.managed) {
        if (host && !deps.pending.has(other) && !hosts.some(value => value.sessionId === host.sessionId)) {
          if (host.retiring && !host.retirement) {
            const lifecycle = await deps.lifecycle(other);
            if (!lifecycle || lifecycle.sessionId !== host.sessionId) continue;
            const identity = await procIdentity(lifecycle.pid);
            if (identity && identity.state !== 'Z' && identity.state !== 'X') {
              host.retirement = { pid: lifecycle.pid, start: identity.start, socketPath: lifecycle.socketPath };
              continue;
            }
          }
          if (host.retirement) {
            const identity = await procIdentity(host.retirement.pid);
            if (identity && identity.start === host.retirement.start && identity.state !== 'Z' && identity.state !== 'X') continue;
          }
          if (host.identity) {
            const identity = await procIdentity(host.identity.pid);
            if (identity && identity.start === host.identity.start && identity.state !== 'Z' && identity.state !== 'X') continue;
          }
          if (host.process?.pid && !host.exited) {
            const supervisor = await procIdentity(host.process.pid);
            if (supervisor && supervisor.state !== 'Z' && supervisor.state !== 'X') continue;
          }
          deps.managed.delete(other);
          deps.forgetActivity(other);
        }
      }
      await beforeMutation?.();
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (!deps.managed.has(id) && ![...deps.reservations.values()].includes(id)) {
        if (deps.capacityUsed() >= deps.sessionLimit) await deps.retireIdle(0);
        if (deps.capacityUsed() >= deps.sessionLimit) throw new SessionCapacityError(deps.sessionLimit);
      }
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (reservation) deps.reservations.set(reservation, id);
      else if (!deps.managed.has(id)) deps.managed.set(id,null);
      if (!reservation) deps.hostActivity(id).lastUsed = Date.now();
    } finally {
      resolve();
    }
  }

  return { claimManaged };
}

