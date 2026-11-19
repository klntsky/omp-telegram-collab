import { spawn } from 'node:child_process';
import { readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hostSupervisorPath, hostLifecyclePath } from '../host-assets.js';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type DurableBinding, type ManagedHost, type HostLifecycle } from './types.js';
import { SessionRetiringError } from './types.js';
import { privateFile } from './files.js';
import { record, errno, delay } from './values.js';
import { childEnvironment } from './environment.js';
import { activeLaunchDir, beginLaunch, cancelUnspawnedLaunch, readLaunch, launchUnresolved, launchFailure, launchProcess, recordLaunchHost, killLaunch } from './launch-record.js';
import { ControlRoomUnavailableError } from './registry.js';
interface StartupDependencies {
  readonly managed: Map<string, ManagedHost | null>;
  readonly config: AppConfig;
  prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }>;
  refreshConversation(session: TopicSession): Promise<void>;
  acquire(): Promise<void>;
  readonly closed: boolean;
  readonly stopping: Map<string, Promise<void>>;
  assertActive(): void;
  list(deadline: number): Promise<RegistryHost[]>;
  resolve(host: RegistryHost, deadline: number): Promise<HostBinding>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  presetLaunch(session: TopicSession): Promise<{ overlay: Record<string, unknown>; args: string[]; preset?: string }>;
  readonly killing: Map<string, Promise<void>>;
}

// This owner keeps the complete startup transaction and its cleanup together.
export interface RuntimeStartup {
  ensureManaged(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
}

export function createStartup(deps: StartupDependencies): RuntimeStartup {

  async function ensureManaged(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding> {
    await deps.refreshConversation(session);
    const id = session.id;
    let owned = deps.managed.get(id);
    let spawned = false;
    let discoveryFailure: Error | undefined;
    let launchPrepared = false;
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    let prepared: { dir: string; pin: DurableBinding };
    try { prepared = await deps.prepare(session); }
    catch (error) {
      if (!owned) deps.managed.delete(id);
      throw error;
    }
    try {
      await deps.acquire();
      const { dir: root, pin } = prepared;
      const existing = await readLaunch(root);
      let dir = existing ? await activeLaunchDir(root) : root;
      const launchPin = { ...pin, sessionId: existing?.sessionId ?? pin.sessionId };
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
      deps.assertActive();
      let hosts = await deps.list(deadline);
      const matches = existing && !existing.resolved && existing.host
        ? hosts.filter(host => host.pid === existing.host!.pid && host.instanceId === existing.host!.instanceId)
        : [];
      if (matches.length > 1) throw new Error('More than one host is serving the managed OMP session');
      if (matches.length === 1) {
        const host = matches[0]!;
        if (await realpath(host.cwd) !== pin.cwd) throw new Error('Managed host working directory changed');
        if (host.sessionId !== pin.sessionId || !await launchProcess(root, host.pid)) throw new Error('OMP launch ownership is unresolved; cannot safely start another process');
        if (owned?.retirement?.error !== undefined) throw owned.retirement.error;
        owned ??= { sessionId: pin.sessionId, exited: false, retiring: false };
        while (!await presetReady(dir, launchPin, host.pid)) {
          if (Date.now() >= deadline) throw new Error('Managed OMP startup preset timed out');
          if (deps.closed) throw new Error('OMP runtime is stopping');
          if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
          deps.assertActive();
          await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        }
        const binding = await deps.resolve(host,deadline);
        const lifecycle = await deps.lifecycle(id);
        owned ??= { sessionId: pin.sessionId, exited: false, retiring: false };
        owned.binding = binding;
        owned.cwd = pin.cwd;
        const currentLifecycle = lifecycle?.pid === host.pid && lifecycle.sessionId === pin.sessionId;
        owned.retiring = currentLifecycle === true && lifecycle.retiring === true;
        deps.managed.set(id,owned);
        if (owned.retiring) throw new SessionRetiringError('Session is retiring; rejoin after it settles');
        deps.assertActive();
        if (deps.closed) throw new Error('OMP runtime is stopping');
        if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
        return binding;
      }
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
      if (await launchUnresolved(root)) throw new Error('OMP launch ownership is unresolved; cannot safely start another process');
      await beforeMutation?.();
      const launch = await deps.presetLaunch(session);
      dir = await beginLaunch(root, pin.sessionId, pin.cwd);
      launchPrepared = true;
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
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
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
        env: { ...childEnvironment(), OMP_TELEGRAM_SESSION_DIR: dir, OMP_TELEGRAM_LAUNCH_ID: path.basename(dir), OMP_TELEGRAM_DEFAULT_PRESET: launch.preset ?? '' },
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      owned = { sessionId: pin.sessionId, cwd: pin.cwd, exited: false, retiring: false };
      spawned = true;
      deps.managed.set(id,owned);
      const record: { failure?: Error; exited: boolean } = { exited: false };
      child.once('error', error => {
        record.failure = error;
        record.exited = true;
        if (!child.pid) spawned = false;
      });
      child.once('exit',() => {
        record.exited = true;
      });
      while (Date.now() < deadline) {
        if (deps.closed) throw new Error('OMP runtime is stopping');
        if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
        deps.assertActive();
        if (record.failure) throw record.failure;
        if (launch.preset !== undefined) await presetReady(dir, pin);
        if (record.exited || !child.pid) throw new Error('Managed OMP process exited before its host was available');
        for (const host of hosts) {
          if (!await launchProcess(root, host.pid)) continue;
          if (host.sessionId !== pin.sessionId || await realpath(host.cwd) !== pin.cwd) throw new Error('Managed OMP process switched its pinned session');
          if (!await presetReady(dir, pin, host.pid)) continue;
          await recordLaunchHost(root, host);
          let binding: HostBinding;
          try {
            binding = await deps.resolve(host,deadline);
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 1 ||
                !error.message.endsWith(`\nerror: no active Collab host matches ${host.instanceId}\n`)) throw error;
            discoveryFailure = error;
            continue;
          }
          owned.binding = binding;
          deps.assertActive();
          if (deps.closed) throw new Error('OMP runtime is stopping');
          if (deps.stopping.has(id)) throw new SessionRetiringError('OMP runtime is stopping');
          return binding;
        }
        await delay(Math.min(200,Math.max(1,deadline-Date.now())));
        if (Date.now() < deadline) hosts = await deps.list(deadline);
      }
      throw discoveryFailure ?? new Error('Managed OMP startup timed out');
    } catch (error) {
      if (launchPrepared && !spawned) {
        try { await cancelUnspawnedLaunch(prepared.dir); }
        catch (cleanupError) {
          if (error instanceof Error) Object.defineProperty(error, 'cleanupError', { value: cleanupError, configurable: true });
        }
      }
      if (
        discoveryFailure &&
        error instanceof Error &&
        error !== discoveryFailure &&
        (error.message === 'OMP discovery timed out' ||
          ('killed' in error && error.killed === true &&
            'code' in error && error.code === null &&
            'signal' in error && error.signal === 'SIGKILL'))
      ) {
        Object.defineProperty(discoveryFailure, 'cause', { value: error, configurable: true });
        error = discoveryFailure;
      }
      if (spawned && !deps.killing.has(id) && !(error instanceof ControlRoomUnavailableError)) {
        const cleanup = killLaunch(prepared.dir);
        if (!deps.stopping.has(id)) deps.stopping.set(id, cleanup);
        try { await cleanup; }
        catch (cleanupError) {
          try { await launchFailure(prepared.dir, cleanupError); }
          catch (persistenceError) {
            if (cleanupError instanceof Error) Object.defineProperty(cleanupError, 'persistenceError', { value: persistenceError, configurable: true });
          }
          if (error instanceof Error) {
            Object.defineProperty(error, 'cleanupError', { value: cleanupError, configurable: true });
            error.message += `\nOMP startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          }
        }
        finally {
          if (deps.stopping.get(id) === cleanup) deps.stopping.delete(id);
        }
      }
      if (!owned && deps.managed.get(id) === owned) deps.managed.delete(id);
      if (spawned && error instanceof Error) {
        error.message += `\nOMP terminal diagnostics (private; may contain session content): ${path.join(await activeLaunchDir(prepared.dir), 'terminal.log')} (previous output: terminal.log.1)`;
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

