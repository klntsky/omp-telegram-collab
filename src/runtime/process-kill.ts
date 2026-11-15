import { OmpProcessError, systemError, parseJson, OmpIdentityError, OmpSessionUnavailableError } from './errors.js';
import { readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type DurableBinding, type ManagedHost, type HostLifecycle } from './types.js';
import { readHeader } from './files.js';
import { procIdentity, belongsTo } from './process.js';
import { errno, delay } from './values.js';
interface ProcessKillDependencies {
  readonly config: AppConfig;
  readonly managed: Map<string, ManagedHost | null>;
  forgetActivity(id: string): void;
  list(deadline: number): Promise<RegistryHost[]>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
}

// This owner keeps the complete process kill transaction and its cleanup together.
export interface RuntimeProcessKill {
  killSession(session: TopicSession): Promise<void>;
}

export function createProcessKill(deps: ProcessKillDependencies): RuntimeProcessKill {

  async function configuredExecutable(): Promise<string> {
    const executable = deps.config.omp.executable;
    if (executable.includes('/')) return realpath(path.resolve(executable));
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      try { return await realpath(path.resolve(directory || process.cwd(), executable)); }
      catch (error) { error = systemError(error, 'process-kill OS operation'); if (!errno(error, 'ENOENT') && !errno(error, 'ENOTDIR')) throw error; }
    }
    throw new OmpProcessError('Kill OMP process', `executable ${deps.config.omp.executable}`, 'Cannot identify the configured OMP executable');
  }

  async function killProcess(pid: number, cwd: string, executable: string, validate: () => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || await belongsTo(process.pid, pid)) throw new OmpProcessError('Kill OMP process', `pid ${pid}; cwd ${cwd}`, 'Refusing to kill an unrelated OMP process');
    const identity = await procIdentity(pid);
    if (!identity || identity.state === 'Z' || identity.state === 'X') return;
    try {
      if (await realpath(`/proc/${pid}/cwd`) !== cwd) throw new OmpIdentityError('OMP process working directory changed', `Kill process ${pid} in ${cwd}`);
      const actual = await realpath(`/proc/${pid}/exe`);
      if (actual !== executable) {
        const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        let matches = false;
        for (const argument of argv.slice(0, 3)) {
          if (!argument.startsWith('/')) continue;
          try { if (await realpath(argument) === executable) matches = true; }
          catch (error) { error = systemError(error, 'process-kill OS operation'); if (!errno(error, 'ENOENT') && !errno(error, 'ENOTDIR')) throw error; }
        }
        if (!matches) throw new OmpProcessError('Kill OMP process', `pid ${pid}; cwd ${cwd}`, 'OMP process executable changed');
      }
      await validate();
      const current = await procIdentity(pid);
      if (!current || current.state === 'Z' || current.state === 'X') return;
      if (current.start !== identity.start) throw new OmpIdentityError('OMP process identity changed before kill', `Kill process ${pid} in ${cwd}`);
      process.kill(pid, 'SIGKILL');
    } catch (error) { error = systemError(error, 'process-kill OS operation');
      if (errno(error, 'ENOENT') || errno(error, 'ESRCH')) {
        const current = await procIdentity(pid);
        if (!current || current.start !== identity.start || current.state === 'Z' || current.state === 'X') return;
      }
      throw error;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await procIdentity(pid);
      if (!current || current.start !== identity.start || current.state === 'Z' || current.state === 'X') return;
      await delay(25);
    }
    throw new OmpProcessError('Kill OMP process', `pid ${pid}; cwd ${cwd}`, 'OMP process did not exit after SIGKILL');
  }

  async function killSession(session: TopicSession): Promise<void> {
    const id = session.id;
    const owned = deps.managed.get(id);
    let pin: DurableBinding | undefined;
    if (session.runtime.kind === 'managed') {
      const dir = path.resolve(deps.config.dataDir, 'sessions', id);
      try {
        pin = parseJson(await readFile(path.join(dir, 'binding.json'), 'utf8'), 'Read runtime metadata', `session ${id}`) as DurableBinding;
      } catch (error) { error = systemError(error, 'process-kill OS operation');
        if (!errno(error, 'ENOENT')) throw error;
        if (owned) throw new OmpIdentityError('Managed OMP binding is missing', `Kill session ${session.id}`);
        deps.forgetActivity(id);
        return;
      }
      if (pin.version !== 1 || typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) || pin.cwd !== session.cwd) {
        throw new OmpIdentityError('Managed OMP binding is incompatible with this configuration', `Kill session ${session.id}`);
      }
      const header = await readHeader(pin.sessionFile);
      if (header.id !== pin.sessionId || header.cwd !== pin.cwd || (owned && owned.sessionId !== pin.sessionId)) {
        throw new OmpIdentityError('Managed OMP history identity changed', `Kill session ${session.id}`);
      }
    }
    const target = session.runtime;
    const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
    const matches = hosts.filter(host => target.kind === 'attached'
      ? host.instanceId === target.instanceId
      : host.sessionId === pin!.sessionId);
    if (matches.length > 1) throw new OmpProcessError('Kill OMP process', `session ${session.id}`, 'More than one host is serving the OMP session');
    const host = matches[0];
    const executable = host || owned?.process?.pid ? await configuredExecutable() : undefined;
    const lifecycle = pin ? await deps.lifecycle(id) : undefined;
    if (!host && lifecycle && !owned?.process) {
      const identity = await procIdentity(lifecycle.pid);
      if (identity && identity.state !== 'Z' && identity.state !== 'X') throw new OmpSessionUnavailableError('OMP host is not registered; cannot safely kill its process', `Kill session ${session.id}`);
    }
    if (host) {
      if (target.kind === 'attached' && host.sessionId !== target.sessionId) throw new OmpIdentityError('Attached OMP session identity changed', `Kill session ${session.id}`);
      const cwd = await realpath(host.cwd);
      if (cwd !== session.cwd) throw new OmpIdentityError('OMP host does not belong to this session working directory', `Kill session ${session.id}`);
      if (pin && cwd !== pin.cwd) throw new OmpIdentityError('Managed host working directory changed', `Kill session ${session.id}`);
      if (owned?.binding && (owned.binding.instanceId !== host.instanceId || owned.binding.sessionId !== host.sessionId)) {
        throw new OmpIdentityError('Managed OMP host identity changed', `Kill session ${session.id}`);
      }
      if (lifecycle && (lifecycle.sessionId !== host.sessionId || lifecycle.pid !== host.pid ||
          (owned?.process?.pid && lifecycle.supervisorPid !== owned.process.pid))) {
        throw new OmpIdentityError('Managed OMP lifecycle identity changed', `Kill session ${session.id}`);
      }
      await killProcess(host.pid, cwd, executable!, async () => {
        const current = (await deps.list(Date.now() + 5000)).find(value => value.instanceId === host.instanceId);
        if (!current || current.pid !== host.pid || current.sessionId !== host.sessionId ||
            current.generation !== host.generation || current.cwd !== host.cwd) {
          // Keep both snapshots on the original refusal so its owner can diagnose
          // a registry transition without weakening the process-identity fence.
          throw Object.assign(new OmpIdentityError('OMP host identity changed before kill', `Kill session ${session.id}`), {
            expectedHost: host,
            observedHost: current ?? null,
          });
        }
        if (pin) {
          const argv = (await readFile(`/proc/${host.pid}/cmdline`, 'utf8')).split('\0');
          const resume = argv.indexOf('--resume');
          if (resume < 0 || argv[resume + 1] !== pin.sessionFile) throw new OmpIdentityError('Managed OMP process history changed', `Kill session ${session.id}`);
        }
        if (owned?.process?.pid && !await belongsTo(host.pid, owned.process.pid)) {
          throw new OmpIdentityError('Managed OMP process ancestry changed', `Kill session ${session.id}`);
        }
      });
    }
    // A startup can be cancelled before the host publishes its registry entry.
    // Only inspect children of the supervisor this runtime actually spawned.
    if (pin && owned?.process?.pid && !owned.exited) {
      const supervisor = owned.process.pid;
      let children = '';
      try { children = await readFile(`/proc/${supervisor}/task/${supervisor}/children`, 'utf8'); }
      catch (error) { error = systemError(error, 'process-kill OS operation'); if (!errno(error, 'ENOENT') && !errno(error, 'ESRCH')) throw error; }
      for (const value of children.trim().split(/\s+/).filter(Boolean)) {
        const pid = Number(value);
        await killProcess(pid, pin.cwd, executable!, async () => {
          if (owned.exited || !await belongsTo(pid, supervisor)) throw new OmpIdentityError('Managed OMP startup process identity changed', `Kill session ${session.id}`);
        });
      }
      if (!owned.exited && owned.process.exitCode === null && owned.process.signalCode === null) {
        try { owned.process.kill('SIGKILL'); }
        catch (error) { error = systemError(error, 'process-kill OS operation'); if (!errno(error, 'ESRCH')) throw error; }
      }
    }
    if (lifecycle) {
      const current = await deps.lifecycle(id);
      if (current?.pid === lifecycle.pid && current.sessionId === lifecycle.sessionId && current.socketPath === lifecycle.socketPath) {
        await unlink(path.join(deps.config.dataDir, 'sessions', id, 'lifecycle.json')).catch(error => { error = systemError(error, 'process-kill OS operation');
          if (!errno(error, 'ENOENT')) throw error;
        });
        if (path.dirname(lifecycle.socketPath) === tmpdir() && /^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(lifecycle.socketPath))) {
          await unlink(lifecycle.socketPath).catch(error => { error = systemError(error, 'process-kill OS operation'); if (!errno(error, 'ENOENT')) throw error; });
        }
      }
    }
    if (owned) { owned.exited = true; owned.retiring = false; }
    if (host) {
      for (const [managedId, managed] of deps.managed) {
        if (!managed || managed.sessionId !== host.sessionId || (managed.binding && managed.binding.instanceId !== host.instanceId)) continue;
        managed.exited = true;
        managed.retiring = false;
        deps.managed.delete(managedId);
        deps.forgetActivity(managedId);
      }
    }
    deps.managed.delete(id);
    deps.forgetActivity(id);
  }

  return { killSession };
}

