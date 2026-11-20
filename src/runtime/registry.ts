import { realpath } from 'node:fs/promises';
import type { AppConfig, HostBinding } from '../../shared/contracts.js';
import { parseCollabLink } from '../vendor/link.js';
import { type RegistryHost } from './types.js';
import { createDiscovery, isDiscoveryDeadlineError } from './discovery.js';
import { CollabTransportError } from '../collab.js';
import { procIdentity } from './process.js';
import { delay } from './values.js';
interface RegistryDependencies {
  readonly config: AppConfig;
  assertActive(): void;
  readonly closed: boolean;
  acquire(): Promise<void>;
}

// This owner keeps the complete registry transaction and its cleanup together.
export interface RuntimeRegistry {
  list(deadline: number): Promise<RegistryHost[]>;
  resolve(host: RegistryHost, deadline: number): Promise<HostBinding>;
  attach(instanceId: string, instancePath: string): Promise<HostBinding>;
}

export function createRegistry(deps: RegistryDependencies): RuntimeRegistry {

  const discovery = createDiscovery(deps.config);

  async function list(deadline: number): Promise<RegistryHost[]> {
    const result = await discovery.list(deadline);
    if (result.version !== 1 || !Array.isArray(result.hosts)) throw new Error('Unsupported OMP Collab registry version');
    for (const host of result.hosts as RegistryHost[]) {
      if (!host || typeof host.instanceId !== 'string' || typeof host.sessionId !== 'string' || typeof host.cwd !== 'string' || !Number.isSafeInteger(host.pid) || host.pid < 1 || !Number.isSafeInteger(host.generation) || host.generation < 1 || (host.access !== 'view' && host.access !== 'control') || typeof host.relayConnected !== 'boolean') {
        throw new Error('Invalid OMP Collab registry host');
      }
    }
    return result.hosts as RegistryHost[];
  }

  async function resolve(host: RegistryHost, deadline: number): Promise<HostBinding> {
    deps.assertActive();
    if (host.access !== 'control') throw new Error('OMP host does not publish a connected control room');
    // A live host keeps its identity while reconnecting after relay recovery.
    // Preserve the diagnostic but let the gateway retry instead of ending the session.
    if (!host.relayConnected) throw new CollabTransportError('OMP host does not publish a connected control room');
    const pinned = await procIdentity(host.pid);
    let link: Record<string, unknown>;
    let unavailable: Error | undefined;
    for (;;) {
      try {
        link = await discovery.link(host.instanceId, deadline);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 1 ||
            !error.message.endsWith(`\nerror: no active Collab host matches ${host.instanceId}\n`)) {
          if (unavailable && Date.now() >= deadline && isDiscoveryDeadlineError(error)) {
            Object.defineProperty(unavailable, 'cause', { value: error, configurable: true });
            throw unavailable;
          }
          throw error;
        }
        unavailable = error;
        const process = pinned && await procIdentity(host.pid);
        if (!process || process.start !== pinned!.start || process.state === 'Z' || process.state === 'X' ||
            Date.now() >= deadline) throw unavailable;
        let matches: RegistryHost[];
        try {
          matches = (await list(deadline)).filter(candidate => candidate.instanceId === host.instanceId || candidate.sessionId === host.sessionId);
        } catch (error) {
          if (Date.now() >= deadline && isDiscoveryDeadlineError(error)) {
            Object.defineProperty(unavailable, 'cause', { value: error, configurable: true });
            throw unavailable;
          }
          throw error;
        }
        if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
        const current = matches[0];
        if (current && (current.instanceId !== host.instanceId || current.sessionId !== host.sessionId ||
            current.generation !== host.generation || current.pid !== host.pid || current.cwd !== host.cwd)) {
          const identity = (candidate: RegistryHost) => ({ instanceId: candidate.instanceId, sessionId: candidate.sessionId,
            generation: candidate.generation, pid: candidate.pid, cwd: candidate.cwd });
          throw new Error(`OMP host session changed while resolving its capability\nExpected: ${JSON.stringify(identity(host))}\nObserved: ${JSON.stringify(matches.map(identity))}`);
        }
        if (current && (current.access !== 'control' || !current.relayConnected)) {
          throw new CollabTransportError('OMP host does not publish a connected control room');
        }
        const stillPinned = await procIdentity(host.pid);
        if (!stillPinned || stillPinned.start !== pinned!.start || stillPinned.state === 'Z' || stillPinned.state === 'X' ||
            Date.now() >= deadline) throw unavailable;
        deps.assertActive();
        if (deps.closed) throw new Error('OMP runtime is stopping');
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
      }
    }
    if (link.version !== 1 || link.instanceId !== host.instanceId || link.generation !== host.generation || link.access !== 'control' || typeof link.url !== 'string') {
      throw new Error('OMP host changed while resolving its capability');
    }
    const parsed = parseCollabLink(link.url);
    if ('error' in parsed || !parsed.writeToken) throw new Error('OMP host returned an invalid control capability');
    const identity = (candidate: RegistryHost) => ({ instanceId: candidate.instanceId, sessionId: candidate.sessionId,
      generation: candidate.generation, pid: candidate.pid, cwd: candidate.cwd });
    let missing: Error | undefined;
    for (;;) {
      let matches: RegistryHost[];
      try {
        matches = (await list(deadline)).filter(candidate => candidate.instanceId === host.instanceId || candidate.sessionId === host.sessionId);
      } catch (error) {
        if (missing && Date.now() >= deadline && isDiscoveryDeadlineError(error)) {
          Object.defineProperty(missing, 'cause', { value: error, configurable: true });
          throw missing;
        }
        throw error;
      }
      if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
      const current = matches[0];
      const changed = new Error(`OMP host session changed while resolving its capability\nExpected: ${JSON.stringify(identity(host))}\nObserved: ${JSON.stringify(matches.map(identity))}`);
      if (current) {
        if (current.instanceId !== host.instanceId || current.sessionId !== host.sessionId ||
            current.generation !== host.generation || current.pid !== host.pid || current.cwd !== host.cwd) throw changed;
        if (pinned) {
          const process = await procIdentity(host.pid);
          if (!process || process.start !== pinned.start || process.state === 'Z' || process.state === 'X') throw changed;
        }
        if (current.access !== 'control' || !current.relayConnected) {
          throw new CollabTransportError('OMP host does not publish a connected control room');
        }
        break;
      }
      // Native registry status probes may omit a live host. Its pinned OS lifetime
      // permits another read, never accepting the old snapshot as authorization.
      missing ??= changed;
      const process = pinned && await procIdentity(host.pid);
      if (!process || process.start !== pinned!.start || process.state === 'Z' || process.state === 'X' ||
          Date.now() >= deadline) throw missing;
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    return { instanceId: host.instanceId, sessionId: host.sessionId, generation: host.generation, url: link.url };
  }

  async function attach(instanceId: string, instancePath: string): Promise<HostBinding> {
    deps.assertActive();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Invalid OMP instance identifier');
    await deps.acquire();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const host = (await list(deadline)).find(candidate => candidate.instanceId === instanceId);
    if (!host) throw new Error('OMP host is not available');
    if (await realpath(instancePath) !== instancePath || await realpath(host.cwd) !== instancePath) throw new Error('Attached host does not belong to this instance path');
    const binding = await resolve(host, deadline);
    if (deps.closed) throw new Error('OMP runtime is stopping');
    deps.assertActive();
    return binding;
  }

  return { list, resolve, attach };
}

