import { launchProcess, readLaunch, launchUnresolved } from './launch-record.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type DurableBinding, type HostActivity } from './types.js';
interface SessionsDependencies {
  assertActive(): void;
  readonly closed: boolean;
  readonly pending: Map<string, Promise<HostBinding>>;
  acquire(): Promise<void>;
  list(deadline: number): Promise<RegistryHost[]>;
  readonly config: AppConfig;
  readonly stopping: Map<string, Promise<void>>;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  resolve(host: RegistryHost, deadline: number): Promise<HostBinding>;
  hostActivity(id: string): HostActivity;
}

// This owner keeps the complete sessions transaction and its cleanup together.
export interface RuntimeSessions {
  isRunning(session: TopicSession): Promise<boolean>;
  resolveExisting(session: TopicSession): Promise<HostBinding | undefined>;
  historySource(session: TopicSession): Promise<{ sessionId: string; path: string } | undefined>;
  existingBinding(session: TopicSession): Promise<{ sessionId: string } | undefined>;
}

export function createSessions(deps: SessionsDependencies): RuntimeSessions {

  async function isRunning(session: TopicSession): Promise<boolean> {
    deps.assertActive();
    if (deps.closed || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return false;
    if (deps.pending.has(session.id)) return true;
    if (session.runtime.kind === 'managed') await deps.acquire();
    if (session.runtime.kind === 'managed') {
      return launchUnresolved(path.join(deps.config.dataDir, 'sessions', session.id));
    }
    const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
    const runtime = session.runtime;
    return hosts.some(host => host.instanceId === runtime.instanceId && host.sessionId === runtime.sessionId && host.cwd === session.cwd);
  }

  async function resolveExisting(session: TopicSession): Promise<HostBinding | undefined> {
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance path is not configured');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
    const runtime = session.runtime;
    let pin: DurableBinding | undefined;
    if (runtime.kind === 'managed') {
      pin = await deps.readManagedBinding(session);
      if (!pin) {
        deps.assertActive();
        if (await launchUnresolved(path.join(deps.config.dataDir, 'sessions', session.id))) {
          throw new Error('OMP host is not registered; launch ownership remains unresolved');
        }
        if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
        return undefined;
      }
      if (pin.removedWorktree) throw new Error(`This session's worktree was deleted: ${pin.cwd}`);
    } else if (!/^[A-Za-z0-9_-]{1,128}$/.test(runtime.instanceId)) {
      throw new Error('Invalid OMP instance identifier');
    }
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const root = path.join(deps.config.dataDir, 'sessions', session.id);
    const launch = runtime.kind === 'managed' ? await readLaunch(root) : undefined;
    const hosts = await deps.list(deadline);
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    const matches = hosts.filter(host => runtime.kind === 'attached'
      ? host.instanceId === runtime.instanceId
      : launch && !launch.resolved && launch.host && host.pid === launch.host.pid && host.instanceId === launch.host.instanceId);
    if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
    const host = matches[0];
    if (!host) {
      if (runtime.kind === 'managed' && await launchUnresolved(path.join(deps.config.dataDir, 'sessions', session.id))) {
        throw new Error('OMP host is not registered; launch ownership remains unresolved');
      }
      return undefined;
    }
    if (runtime.kind === 'attached') {
      if (host.sessionId !== runtime.sessionId) throw new Error('Attached OMP session identity changed');
      if (await realpath(session.cwd) !== session.cwd || await realpath(host.cwd) !== session.cwd) {
        throw new Error('Attached host does not belong to this instance path');
      }
    } else {
      if (await realpath(host.cwd) !== pin!.cwd) throw new Error('Managed host working directory changed');
      if (host.sessionId !== pin!.sessionId || !await launchProcess(root, host.pid)) {
        throw new Error('OMP host is not registered; launch ownership remains unresolved');
      }
    }
    const binding = await deps.resolve(host, deadline);
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (runtime.kind === 'managed') {
      deps.hostActivity(session.id).busy = host.busy !== false;
    }
    return binding;
  }

  async function historySource(session: TopicSession): Promise<{ sessionId: string; path: string } | undefined> {
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance path is not configured');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
    if (session.runtime.kind === 'attached') return undefined;
    const pin = await deps.readManagedBinding(session);
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    return pin && { sessionId: pin.sessionId, path: pin.sessionFile };
  }

  async function existingBinding(session: TopicSession): Promise<{ sessionId: string } | undefined> {
    deps.assertActive();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    if (session.runtime.kind !== 'managed') throw new Error('Attached OMP sessions cannot be forked');
    if (session.status !== 'open') throw new Error('Session closed');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance ID is not configured');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
    const pin = await deps.readManagedBinding(session);
    if (pin?.removedWorktree) throw new Error(`This session's worktree was deleted: ${pin.cwd}`);
    return pin ? { sessionId: pin.sessionId } : undefined;
  }

  return { isRunning, resolveExisting, historySource, existingBinding };
}

