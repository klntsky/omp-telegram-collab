import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type DurableBinding, type ManagedHost, type HostActivity } from './types.js';
import { procIdentity } from './process.js';
import { errno } from './values.js';
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
  readonly managed: Map<string, ManagedHost | null>;
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
    const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
    const runtime = session.runtime;
    if (runtime.kind === 'attached') return hosts.some(host => host.instanceId === runtime.instanceId && host.sessionId === runtime.sessionId && host.cwd === session.cwd);
    let pin: DurableBinding;
    try {
      pin = JSON.parse(await readFile(path.join(deps.config.dataDir,'sessions',session.id,'binding.json'),'utf8')) as DurableBinding;
    } catch (error) {
      if (errno(error,'ENOENT')) return false;
      throw error;
    }
    return pin.cwd === session.cwd && hosts.some(host => host.sessionId === pin.sessionId && host.cwd === pin.cwd);
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
        if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
        return undefined;
      }
      if (pin.removedWorktree) throw new Error(`This session's worktree was deleted: ${pin.cwd}`);
    } else if (!/^[A-Za-z0-9_-]{1,128}$/.test(runtime.instanceId)) {
      throw new Error('Invalid OMP instance identifier');
    }
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const hosts = await deps.list(deadline);
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    const matches = hosts.filter(host => runtime.kind === 'attached'
      ? host.instanceId === runtime.instanceId
      : host.sessionId === pin!.sessionId);
    if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
    const host = matches[0];
    if (!host) return undefined;
    if (runtime.kind === 'attached') {
      if (host.sessionId !== runtime.sessionId) throw new Error('Attached OMP session identity changed');
      if (await realpath(session.cwd) !== session.cwd || await realpath(host.cwd) !== session.cwd) {
        throw new Error('Attached host does not belong to this instance path');
      }
    } else if (await realpath(host.cwd) !== pin!.cwd) {
      throw new Error('Managed host working directory changed');
    }
    const binding = await deps.resolve(host, deadline);
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (runtime.kind === 'managed') {
      const owned = deps.managed.get(session.id);
      if (!owned || owned.exited) {
        const identity = await procIdentity(host.pid);
        deps.managed.set(session.id,{sessionId:pin!.sessionId,cwd:pin!.cwd,binding,exited:false,retiring:false,
          ...(identity ? { identity: { pid: host.pid, start: identity.start } } : {})});
        deps.hostActivity(session.id).busy = host.busy !== false;
      } else if (owned.binding?.instanceId === binding.instanceId && owned.binding.sessionId === binding.sessionId &&
          owned.binding.generation !== binding.generation && owned.identity?.pid === host.pid) {
        const previous = owned.binding;
        const previousIdentity = owned.identity;
        const identity = await procIdentity(host.pid);
        deps.assertActive();
        if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
        // Passive reconnect must refresh retirement's room identity without
        // granting ownership of a replacement process or overwriting a newer lookup.
        if (identity && identity.start === previousIdentity.start && identity.state !== 'Z' && identity.state !== 'X' &&
            deps.managed.get(session.id) === owned && owned.binding === previous && owned.identity === previousIdentity && !owned.exited) {
          owned.binding = binding;
        }
      }
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

