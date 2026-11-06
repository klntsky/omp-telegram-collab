import { spawn } from 'node:child_process';
import { readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hostSupervisorPath, hostLifecyclePath } from '../host-assets.js';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type DurableBinding, type ManagedHost, type HostLifecycle } from './types.js';
import { privateFile } from './files.js';
import { procIdentity, belongsTo } from './process.js';
import { record, errno, delay } from './values.js';
interface StartupDependencies {
  readonly managed: Map<string, ManagedHost | null>;
  readonly config: AppConfig;
  prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }>;
  acquire(): Promise<void>;
  readonly closed: boolean;
  readonly stopping: Map<string, Promise<void>>;
  assertActive(): void;
  list(deadline: number): Promise<RegistryHost[]>;
  resolve(host: RegistryHost, deadline: number): Promise<HostBinding>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  presetLaunch(session: TopicSession): Promise<{ overlay: Record<string, unknown>; args: string[]; preset?: string }>;
  readonly killing: Map<string, Promise<void>>;
  shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void>;
}

// This owner keeps the complete startup transaction and its cleanup together.
export interface RuntimeStartup {
  ensureManaged(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
}

export function createStartup(deps: StartupDependencies): RuntimeStartup {

  async function ensureManaged(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding> {
    const id = session.id;
    let owned = deps.managed.get(id);
    let spawned: ManagedHost | undefined;
    let discoveryFailure: Error | undefined;
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    let prepared: { dir: string; pin: DurableBinding };
    try { prepared = await deps.prepare(session); }
    catch (error) {
      if (!owned) deps.managed.delete(id);
      throw error;
    }
    try {
      await deps.acquire();
      const { dir, pin } = prepared;
      if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
      deps.assertActive();
      let hosts = await deps.list(deadline);
      const matches = hosts.filter(host => host.sessionId === pin.sessionId);
      if (matches.length > 1) throw new Error('More than one host is serving the managed OMP session');
      if (matches.length === 1) {
        const host = matches[0]!;
        if (await realpath(host.cwd) !== pin.cwd) throw new Error('Managed host working directory changed');
        while (!await presetReady(dir, pin, host.pid)) {
          if (Date.now() >= deadline) throw new Error('Managed OMP startup preset timed out');
          if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
          deps.assertActive();
          await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        }
        const binding = await deps.resolve(host,deadline);
        const lifecycle = await deps.lifecycle(id);
        owned ??= { sessionId: pin.sessionId, exited: false, retiring: false };
        owned.binding = binding;
        owned.cwd = pin.cwd;
        const identity = await procIdentity(host.pid);
        owned.identity = identity ? { pid: host.pid, start: identity.start } : undefined;
        const currentLifecycle = lifecycle?.pid === host.pid && lifecycle.sessionId === pin.sessionId;
        if (owned.retirement) {
          const identity = await procIdentity(owned.retirement.pid);
          if (!identity || identity.start !== owned.retirement.start || identity.state === 'Z' || identity.state === 'X' ||
              (currentLifecycle && (owned.retirement.pid !== host.pid || owned.retirement.socketPath !== lifecycle.socketPath))) {
            delete owned.retirement;
          }
        }
        if (!owned.retirement && currentLifecycle && lifecycle.retiring === true) {
          if (identity && identity.state !== 'Z' && identity.state !== 'X') {
            owned.retirement = { pid: host.pid, start: identity.start, socketPath: lifecycle.socketPath };
          }
        }
        if (owned.retirement?.error !== undefined) throw owned.retirement.error;
        owned.retiring = owned.retirement !== undefined || (currentLifecycle && lifecycle.retiring === true);
        deps.managed.set(id,owned);
        if (owned.retiring) throw new Error('Session is retiring; rejoin after it settles');
        deps.assertActive();
        if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
        return binding;
      }
      if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
      if (owned?.retirement) {
        const identity = await procIdentity(owned.retirement.pid);
        if (identity && identity.start === owned.retirement.start && identity.state !== 'Z' && identity.state !== 'X') {
          if (owned.retirement.error !== undefined) throw owned.retirement.error;
          throw new Error('Session is retiring; rejoin after it settles');
        }
        delete owned.retirement;
        owned.retiring = false;
      }
      if (owned?.identity) {
        const identity = await procIdentity(owned.identity.pid);
        if (identity && identity.start === owned.identity.start && identity.state !== 'Z' && identity.state !== 'X') {
          throw new Error('OMP host is not registered; cannot safely start another process');
        }
        delete owned.identity;
      }
      await beforeMutation?.();
      const launch = await deps.presetLaunch(session);
      const overlay = {
        collab: { autoStart: 'control', ...(deps.config.omp.relayUrl ? { relayUrl: deps.config.omp.relayUrl } : {}) },
        startup: { checkUpdate: false, setupWizard: false },
        ...launch.overlay,
      };
      await privateFile(path.join(dir, 'runtime.yml'), JSON.stringify(overlay));
      const startupFile = path.join(dir, 'startup-preset.json');
      if (launch.preset !== undefined) {
        await privateFile(startupFile, JSON.stringify({ sessionId: pin.sessionId, preset: launch.preset }));
      } else {
        await unlink(startupFile).catch(error => { if (!errno(error, 'ENOENT')) throw error; });
      }
      await beforeMutation?.();
      deps.assertActive();
      if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
      const child = spawn(process.execPath, [
        hostSupervisorPath,
        deps.config.omp.executable,
        ...launch.args,
        '--cwd',pin.cwd,
        '--config',path.join(dir,'runtime.yml'),
        '--session-dir',dir,
        '--resume',pin.sessionFile,
        '--no-title',
        '--extension',hostLifecyclePath,
      ], {
        cwd: pin.cwd,
        env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: dir, OMP_TELEGRAM_DEFAULT_PRESET: launch.preset ?? '' },
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      owned = { process: child, sessionId: pin.sessionId, cwd: pin.cwd, exited: false, retiring: false };
      spawned = owned;
      deps.managed.set(id,owned);
      const record = owned;
      child.once('error',error => { record.failure = error.message; record.exited = true; });
      child.once('exit',() => {
        record.exited = true;
        if (deps.managed.get(id) === record) deps.managed.delete(id);
      });
      while (Date.now() < deadline) {
        if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
        deps.assertActive();
        if (record.failure) throw new Error(record.failure);
        if (launch.preset !== undefined) await presetReady(dir, pin);
        if (record.exited || !child.pid) throw new Error('Managed OMP process exited before its host was available');
        for (const host of hosts) {
          if (!await belongsTo(host.pid,child.pid)) continue;
          if (host.sessionId !== pin.sessionId || await realpath(host.cwd) !== pin.cwd) throw new Error('Managed OMP process switched its pinned session');
          if (!await presetReady(dir, pin, host.pid)) continue;
          let binding: HostBinding;
          try {
            binding = await deps.resolve(host,deadline);
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 1 ||
                !error.message.endsWith(`\nerror: no active Collab host matches ${host.instanceId}\n`)) throw error;
            discoveryFailure = error;
            continue;
          }
          record.binding = binding;
          const identity = await procIdentity(host.pid);
          if (identity) record.identity = { pid: host.pid, start: identity.start };
          deps.assertActive();
          if (deps.closed || deps.stopping.has(id)) throw new Error('OMP runtime is stopping');
          return binding;
        }
        await delay(Math.min(200,Math.max(1,deadline-Date.now())));
        if (Date.now() < deadline) hosts = await deps.list(deadline);
      }
      throw discoveryFailure ?? new Error('Managed OMP startup timed out');
    } catch (error) {
      if (
        discoveryFailure &&
        error instanceof Error &&
        error !== discoveryFailure &&
        Date.now() >= deadline &&
        (error.message === 'OMP discovery timed out' ||
          ('killed' in error && error.killed === true &&
            'code' in error && error.code === null &&
            'signal' in error && error.signal === 'SIGKILL'))
      ) {
        Object.defineProperty(discoveryFailure, 'cause', { value: error, configurable: true });
        error = discoveryFailure;
      }
      if (spawned && !spawned.exited && !deps.killing.has(id)) {
        const cleanup = deps.shutdown(id, spawned);
        if (!deps.stopping.has(id)) deps.stopping.set(id, cleanup);
        try { await cleanup; }
        catch (cleanupError) {
          if (error instanceof Error) {
            Object.defineProperty(error, 'cleanupError', { value: cleanupError, configurable: true });
            error.message += `\nOMP startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          }
        }
        finally {
          if (deps.stopping.get(id) === cleanup) deps.stopping.delete(id);
        }
      }
      if ((!owned || owned.exited) && deps.managed.get(id) === owned) deps.managed.delete(id);
      if (spawned?.process && error instanceof Error) {
        error.message += `\nOMP terminal diagnostics (private; may contain session content): ${path.join(deps.config.dataDir, 'sessions', id, 'terminal.log')} (previous output: terminal.log.1)`;
      }
      throw error;
    }
  }

  async function presetReady(dir: string, pin: DurableBinding, pid?: number): Promise<boolean> {
    let status: unknown;
    try { status = JSON.parse(await readFile(path.join(dir, 'startup-preset.json'), 'utf8')); }
    catch (error) { if (errno(error, 'ENOENT')) return true; throw error; }
    if (!record(status) || status.sessionId !== pin.sessionId || typeof status.preset !== 'string') {
      throw new Error('Invalid managed OMP startup preset status');
    }
    if (status.pid === undefined) return false;
    if (!Number.isSafeInteger(status.pid) || (pid !== undefined && status.pid !== pid)) throw new Error('Managed OMP startup preset host identity changed');
    if (typeof status.error === 'string') throw new Error(status.error);
    return status.ready === true;
  }

  return { ensureManaged };
}

