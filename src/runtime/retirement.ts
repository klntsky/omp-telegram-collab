import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { ManagedHost, HostLifecycle } from './types.js';
import { privateFile } from './files.js';
import { errno, delay } from './values.js';
import { activeLaunchDir, launchFailure, launchProcess, settleLaunch } from './launch-record.js';
import { requestLifecycle } from './lifecycle-client.js';

interface RetirementDependencies {
  readonly managed: Map<string, ManagedHost | null>;
  forgetActivity(id: string): void;
  readonly killing: Map<string, Promise<void>>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  readonly config: AppConfig;
}

export interface RuntimeRetirement {
  shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void>;
}

export function createRetirement(deps: RetirementDependencies): RuntimeRetirement {
  async function settle(id: string, host: ManagedHost): Promise<boolean> {
    if (!await settleLaunch(path.join(deps.config.dataDir, 'sessions', id))) return false;
    host.exited = true;
    host.retiring = false;
    delete host.retirement;
    if (deps.managed.get(id) === host) {
      deps.managed.delete(id);
      deps.forgetActivity(id);
    }
    return true;
  }

  async function shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void> {
    if (deps.killing.has(id) || await settle(id, host)) return;
    const root = path.join(deps.config.dataDir, 'sessions', id);
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    let lifecycle = await deps.lifecycle(id);
    while (!lifecycle && !guard && Date.now() < deadline) {
      if (deps.killing.has(id) || await settle(id, host)) return;
      await delay(100);
      lifecycle = await deps.lifecycle(id);
    }
    if (!lifecycle || lifecycle.retirement !== 1 || (guard === 'worktree' && !lifecycle.worktree)) {
      if (!guard || guard === 'worktree') throw new Error('This running OMP host does not support safe retirement. Stop it with /kill, then send a new prompt to load the updated lifecycle extension.');
      return;
    }
    const identity = await launchProcess(root, lifecycle.pid);
    if (!identity || lifecycle.sessionId !== host.sessionId) throw new Error('Managed OMP lifecycle identity changed');
    if (host.retirement?.error !== undefined && host.retirement.start === identity.start && host.retirement.socketPath === lifecycle.socketPath) throw host.retirement.error;
    host.retiring = lifecycle.retiring === true;
    host.retirement = { pid: lifecycle.pid, start: identity.start, socketPath: lifecycle.socketPath };
    if (host.retiring || deps.killing.has(id)) return;

    const requestId = randomUUID();
    const grant = path.join(await activeLaunchDir(root), `retirement-${requestId}.request`);
    await privateFile(grant, '', true);
    host.retiring = true;
    let response: Record<string, unknown> = {};
    try {
      response = await requestLifecycle(lifecycle, {
        type: 'retire', requestId, sessionId: host.sessionId, pid: lifecycle.pid,
        deadline: Date.now() + 2000, guard: guard ? 'idle' : 'none',
      });
    } catch (error) {
      console.error(`Session ${id} retirement request failed:`, error);
    }
    if (response.outcome !== 'requested') {
      try {
        let cancelled = false;
        try { await unlink(grant); cancelled = true; }
        catch (error) { if (!errno(error, 'ENOENT')) throw error; }
        const observed = await deps.lifecycle(id);
        host.retiring = !cancelled || (observed?.pid === lifecycle.pid && observed.socketPath === lifecycle.socketPath && observed.retiring === true);
        if (!host.retiring) delete host.retirement;
      } catch (error) {
        host.retirement!.error = error;
        throw error;
      }
      if (typeof response.error === 'string') throw new Error(response.error);
      if (!host.retiring) return;
    }
    const exitDeadline = Date.now() + 7500;
    while (Date.now() < exitDeadline) {
      if (deps.killing.has(id) || await settle(id, host)) return;
      await delay(100);
    }
  }

  return { shutdown: async (id, host, guard) => {
    try { await shutdown(id, host, guard); }
    catch (error) {
      try { await launchFailure(path.join(deps.config.dataDir, 'sessions', id), error); }
      catch (failure) { throw new AggregateError([error, failure], `${error instanceof Error ? error.message : String(error)}\n${failure instanceof Error ? failure.message : String(failure)}`); }
      throw error;
    }
  } };
}
