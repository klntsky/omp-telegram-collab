import { parseJson, OmpHostControlError, OmpProtocolError, systemError, OmpIdentityError, OmpSessionUnavailableError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createConnection } from 'node:net';
import type { AppConfig } from '../../shared/contracts.js';
import { type RegistryHost, type ManagedHost, type HostLifecycle } from './types.js';
import { privateFile } from './files.js';
import { procIdentity } from './process.js';
import { record, errno, delay } from './values.js';
interface RetirementDependencies {
  readonly managed: Map<string, ManagedHost | null>;
  forgetActivity(id: string): void;
  readonly killing: Map<string, Promise<void>>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  list(deadline: number): Promise<RegistryHost[]>;
  readonly config: AppConfig;
}

// This owner keeps the complete retirement transaction and its cleanup together.
export interface RuntimeRetirement {
  shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void>;
}

export function createRetirement(deps: RetirementDependencies): RuntimeRetirement {

  async function settleManagedExit(id: string, host: ManagedHost): Promise<boolean> {
    if (host.retiring && !host.retirement && !host.identity && !host.process) return false;
    if (host.identity) {
      const identity = await procIdentity(host.identity.pid);
      if (identity && identity.start === host.identity.start && identity.state !== 'Z' && identity.state !== 'X') return false;
    }
    if (host.process?.pid && !host.exited) {
      const supervisor = await procIdentity(host.process.pid);
      if (supervisor && supervisor.state !== 'Z' && supervisor.state !== 'X') return false;
    }
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
    if (host.exited) return;
    if (deps.killing.has(id)) return;
    let lifecycle = await deps.lifecycle(id);
    const registered = async (): Promise<RegistryHost | undefined> => {
      const matches = (await deps.list(Date.now() + 5000)).filter(value => value.sessionId === host.sessionId);
      if (matches.length > 1) throw new OmpProtocolError('Resolve OMP host', `session ${id}; native session ${host.sessionId}`, 'More than one host is serving the OMP session');
      return matches[0];
    };
    let current = await registered();
    if (host.process?.pid && !host.binding) {
      const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
      while (!host.exited && !deps.killing.has(id) &&
          (!current || lifecycle?.pid !== current.pid || lifecycle.supervisorPid !== host.process.pid) && Date.now() < deadline) {
        const supervisor = await procIdentity(host.process.pid);
        if (!supervisor || supervisor.state === 'Z' || supervisor.state === 'X') break;
        await delay(100);
        lifecycle = await deps.lifecycle(id);
        current = await registered();
      }
    }
    if (deps.killing.has(id)) return;
    if (host.retirement) {
      const previous = await procIdentity(host.retirement.pid);
      const alive = previous && previous.start === host.retirement.start && previous.state !== 'Z' && previous.state !== 'X';
      const replacement = current && lifecycle?.pid === current.pid && lifecycle.sessionId === host.sessionId &&
        (host.retirement.pid !== current.pid || host.retirement.socketPath !== lifecycle.socketPath);
      if (!alive && !current && (!lifecycle ||
          (lifecycle.pid === host.retirement.pid && lifecycle.socketPath === host.retirement.socketPath))) {
        await settleManagedExit(id, host);
        return;
      }
      if (alive && !replacement) {
        if (host.retirement.error !== undefined) throw host.retirement.error;
        host.retiring = true;
        return;
      }
      if (replacement) delete host.identity;
      delete host.retirement;
      host.retiring = false;
    }
    if (!current) {
      if (lifecycle) {
        if (lifecycle.sessionId !== host.sessionId) throw new OmpIdentityError('Managed OMP lifecycle identity changed', `Retire session ${id} (${host.sessionId})`);
        const identity = await procIdentity(lifecycle.pid);
        if (identity && identity.state !== 'Z' && identity.state !== 'X') {
          host.identity = { pid: lifecycle.pid, start: identity.start };
          if (!guard && lifecycle.retirement !== 1) throw new OmpSessionUnavailableError('This running OMP host does not support safe retirement. Stop it with /kill, then send a new prompt to load the updated lifecycle extension.', `Retire session ${id} (${host.sessionId})`);
          if (lifecycle.retiring === true && lifecycle.retirement === 1) {
            host.retiring = true;
            host.retirement = { pid: lifecycle.pid, start: identity.start, socketPath: lifecycle.socketPath };
            return;
          }
          if (!guard) throw new OmpSessionUnavailableError('OMP host is not registered; cannot safely retire its process', `Retire session ${id} (${host.sessionId})`);
          return;
        }
      }
      if (await settleManagedExit(id, host)) return;
    } else {
      if (host.cwd !== undefined && await realpath(current.cwd) !== host.cwd) throw new OmpIdentityError('Managed host working directory changed', `Retire session ${id} (${host.sessionId})`);
      if (host.binding && (host.binding.instanceId !== current.instanceId || host.binding.sessionId !== current.sessionId ||
          host.binding.generation !== current.generation)) throw new OmpIdentityError('Managed OMP host identity changed', `Retire session ${id} (${host.sessionId})`);
      if (lifecycle && (lifecycle.sessionId !== host.sessionId || lifecycle.pid !== current.pid ||
          (host.process?.pid && lifecycle.supervisorPid !== host.process.pid))) {
        throw new OmpIdentityError('Managed OMP lifecycle identity changed', `Retire session ${id} (${host.sessionId})`);
      }
    }
    const identity = current ? await procIdentity(current.pid) : null;
    if (current && identity && host.identity?.pid === current.pid && host.identity.start !== identity.start) {
      await settleManagedExit(id, host);
      return;
    }
    if (current && identity) host.identity = { pid: current.pid, start: identity.start };
    if (current && (!identity || identity.state === 'Z' || identity.state === 'X')) {
      await settleManagedExit(id, host);
      return;
    }
    if (!lifecycle || lifecycle.retirement !== 1 || (guard === 'worktree' && lifecycle.worktree !== true)) {
      if (guard === 'worktree') throw new OmpSessionUnavailableError('This running OMP host does not support idle-guarded worktree switching. Stop it when idle with /kill, then retry /worktree.', `Retire session ${id} (${host.sessionId})`);
      if (!guard) throw new OmpSessionUnavailableError('This running OMP host does not support safe retirement. Stop it with /kill, then send a new prompt to load the updated lifecycle extension.', `Retire session ${id} (${host.sessionId})`);
      return;
    }
    if (!current || !identity) return;
    const alreadyRetiring = host.retiring || lifecycle.retiring === true;
    if (alreadyRetiring) {
      host.retiring = true;
      host.retirement = { pid: lifecycle.pid, start: identity.start, socketPath: lifecycle.socketPath };
      return;
    }
    if (deps.killing.has(id)) return;
    const requestId = randomUUID();
    const grant = path.join(deps.config.dataDir, 'sessions', id, `retirement-${requestId}.request`);
    await privateFile(grant, '', true);
    host.retiring = true;
    host.retirement = { pid: lifecycle.pid, start: identity.start, socketPath: lifecycle.socketPath };
    const retirement = host.retirement;
    const requestDeadline = Date.now() + 2000;
    const request = `${JSON.stringify({
      type: 'retire', requestId, sessionId: host.sessionId, pid: lifecycle.pid,
      deadline: requestDeadline, guard: guard ? 'idle' : 'none',
    })}\n`;
    const { promise, resolve } = Promise.withResolvers<{ outcome: 'requested' | 'busy' | 'expired' | 'unknown'; error?: Error }>();
    const socket = createConnection(lifecycle.socketPath);
    let settled = false;
    const done = (outcome: 'requested' | 'busy' | 'expired' | 'unknown', error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ outcome, ...(error ? { error } : {}) });
    };
    const unknown = (error: Error) => { console.error(`Retire session ${id} communication failed:`, error); done('unknown'); };
    const timer = setTimeout(() => unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Retirement request timed out')), Math.max(1, requestDeadline - Date.now()));
    socket.setEncoding('utf8');
    socket.once('error', error => {
      if (!settled) console.error(`Session ${id} retirement socket failed:`, error);
      unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Retirement communication failed'));
    });
    socket.once('connect', () => socket.write(request));
    let response = '';
    socket.on('data', data => {
      response += data;
      if (Buffer.byteLength(response) > 16384) { unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Invalid or oversized retirement response')); return; }
      if (!response.includes('\n')) return;
      try {
        const result: unknown = parseJson(response.trim(), 'Retire host', `session ${id}; pid ${lifecycle.pid}`);
        if (!record(result) || result.requestId !== requestId || result.sessionId !== host.sessionId ||
            result.pid !== lifecycle.pid) { unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Invalid or oversized retirement response')); return; }
        if (typeof result.error === 'string') {
          const error = result.errorKind === 'busy' || result.errorKind === 'rejected' || result.errorKind === 'unexpected'
            ? new OmpHostControlError(result.errorKind === 'busy' ? 'rejected' : result.errorKind, 'Retire host', host.sessionId, result.error, { cause: { message: result.error, kind: result.errorKind } })
            : new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, `Invalid lifecycle error discriminator: ${result.error}`);
          done('unknown', error);
          return;
        }
        done(result.outcome === 'requested' || result.outcome === 'busy' || result.outcome === 'expired' ? result.outcome : 'unknown');
      } catch (error) { error = systemError(error, 'retirement OS operation');
        console.error(`Session ${id} retirement response parsing failed:`, error);
        unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Retirement communication failed'));
      }
    });
    socket.once('end', () => unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Retirement socket ended without a response')));
    socket.once('close', () => unknown(new OmpProtocolError('Retire host', `session ${id}; pid ${lifecycle.pid}`, 'Retirement socket closed without a response')));
    const result = await promise;
    if (result.outcome !== 'requested') {
      let cancelled = false;
      try {
        try { await unlink(grant); cancelled = true; }
        catch (error) { error = systemError(error, 'retirement OS operation'); if (!errno(error, 'ENOENT')) throw error; }
        const observed = await deps.lifecycle(id);
        const sameHost = observed?.pid === lifecycle.pid && observed.supervisorPid === lifecycle.supervisorPid &&
          observed.sessionId === lifecycle.sessionId && observed.socketPath === lifecycle.socketPath;
        host.retiring = alreadyRetiring || (sameHost && observed.retiring === true) || !cancelled;
        if (!host.retiring) delete host.retirement;
      } catch (error) { error = systemError(error, 'retirement OS operation');
        retirement.error = error;
        throw error;
      }
      if (result.error) throw result.error;
      if (!host.retiring) return;
    }
    const deadline = Date.now()+7500;
    while (Date.now() < deadline) {
      const current = await procIdentity(lifecycle.pid);
      if (!current || current.start !== identity.start || current.state === 'Z' || current.state === 'X') {
        if (await settleManagedExit(id, host)) return;
      }
      await delay(100);
      if (deps.killing.has(id)) return;
    }
  }

  return { shutdown };
}

