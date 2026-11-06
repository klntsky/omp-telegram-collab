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
      catch (error) { if (!errno(error, 'ENOENT') && !errno(error, 'ENOTDIR')) throw error; }
    }
    throw new Error('Cannot identify the configured OMP executable');
  }

  async function killProcess(pid: number, cwd: string, executable: string, validate: () => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || await belongsTo(process.pid, pid)) throw new Error('Refusing to kill an unrelated OMP process');
    const identity = await procIdentity(pid);
    if (!identity || identity.state === 'Z' || identity.state === 'X') return;
    try {
      if (await realpath(`/proc/${pid}/cwd`) !== cwd) throw new Error('OMP process working directory changed');
      const actual = await realpath(`/proc/${pid}/exe`);
      if (actual !== executable) {
        const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        let matches = false;
        for (const argument of argv.slice(0, 3)) {
          if (!argument.startsWith('/')) continue;
          try { if (await realpath(argument) === executable) matches = true; }
          catch (error) { if (!errno(error, 'ENOENT') && !errno(error, 'ENOTDIR')) throw error; }
        }
        if (!matches) throw new Error('OMP process executable changed');
      }
      await validate();
      const current = await procIdentity(pid);
      if (!current || current.state === 'Z' || current.state === 'X') return;
      if (current.start !== identity.start) throw new Error('OMP process identity changed before kill');
      process.kill(pid, 'SIGKILL');
    } catch (error) {
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
    throw new Error('OMP process did not exit after SIGKILL');
  }

  async function killSession(session: TopicSession): Promise<void> {
    const id = session.id;
    const owned = deps.managed.get(id);
    let pin: DurableBinding | undefined;
    if (session.runtime.kind === 'managed') {
      const dir = path.resolve(deps.config.dataDir, 'sessions', id);
      try {
        pin = JSON.parse(await readFile(path.join(dir, 'binding.json'), 'utf8')) as DurableBinding;
      } catch (error) {
        if (!errno(error, 'ENOENT')) throw error;
        if (owned) throw new Error('Managed OMP binding is missing');
        deps.forgetActivity(id);
        return;
      }
      if (pin.version !== 1 || typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) || pin.cwd !== session.cwd) {
        throw new Error('Managed OMP binding is incompatible with this configuration');
      }
      const header = await readHeader(pin.sessionFile);
      if (header.id !== pin.sessionId || header.cwd !== pin.cwd || (owned && owned.sessionId !== pin.sessionId)) {
        throw new Error('Managed OMP history identity changed');
      }
    }
    const target = session.runtime;
    const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
    const matches = hosts.filter(host => target.kind === 'attached'
      ? host.instanceId === target.instanceId
      : host.sessionId === pin!.sessionId);
    if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
    const host = matches[0];
    const executable = host || owned?.process?.pid ? await configuredExecutable() : undefined;
    const lifecycle = pin ? await deps.lifecycle(id) : undefined;
    if (!host && lifecycle && !owned?.process) {
      const identity = await procIdentity(lifecycle.pid);
      if (identity && identity.state !== 'Z' && identity.state !== 'X') throw new Error('OMP host is not registered; cannot safely kill its process');
    }
    if (host) {
      if (target.kind === 'attached' && host.sessionId !== target.sessionId) throw new Error('Attached OMP session identity changed');
      const cwd = await realpath(host.cwd);
      if (cwd !== session.cwd) throw new Error('OMP host does not belong to this session working directory');
      if (pin && cwd !== pin.cwd) throw new Error('Managed host working directory changed');
      if (owned?.binding && (owned.binding.instanceId !== host.instanceId || owned.binding.sessionId !== host.sessionId)) {
        throw new Error('Managed OMP host identity changed');
      }
      if (lifecycle && (lifecycle.sessionId !== host.sessionId || lifecycle.pid !== host.pid ||
          (owned?.process?.pid && lifecycle.supervisorPid !== owned.process.pid))) {
        throw new Error('Managed OMP lifecycle identity changed');
      }
      await killProcess(host.pid, cwd, executable!, async () => {
        const current = (await deps.list(Date.now() + 5000)).find(value => value.instanceId === host.instanceId);
        if (!current || current.pid !== host.pid || current.sessionId !== host.sessionId ||
            current.generation !== host.generation || current.cwd !== host.cwd) {
          throw new Error('OMP host identity changed before kill');
        }
        if (pin) {
          const argv = (await readFile(`/proc/${host.pid}/cmdline`, 'utf8')).split('\0');
          const resume = argv.indexOf('--resume');
          if (resume < 0 || argv[resume + 1] !== pin.sessionFile) throw new Error('Managed OMP process history changed');
        }
        if (owned?.process?.pid && !await belongsTo(host.pid, owned.process.pid)) {
          throw new Error('Managed OMP process ancestry changed');
        }
      });
    }
    // A startup can be cancelled before the host publishes its registry entry.
    // Only inspect children of the supervisor this runtime actually spawned.
    if (pin && owned?.process?.pid && !owned.exited) {
      const supervisor = owned.process.pid;
      let children = '';
      try { children = await readFile(`/proc/${supervisor}/task/${supervisor}/children`, 'utf8'); }
      catch (error) { if (!errno(error, 'ENOENT') && !errno(error, 'ESRCH')) throw error; }
      for (const value of children.trim().split(/\s+/).filter(Boolean)) {
        const pid = Number(value);
        await killProcess(pid, pin.cwd, executable!, async () => {
          if (owned.exited || !await belongsTo(pid, supervisor)) throw new Error('Managed OMP startup process identity changed');
        });
      }
      if (!owned.exited && owned.process.exitCode === null && owned.process.signalCode === null) {
        try { owned.process.kill('SIGKILL'); }
        catch (error) { if (!errno(error, 'ESRCH')) throw error; }
      }
    }
    if (lifecycle) {
      const current = await deps.lifecycle(id);
      if (current?.pid === lifecycle.pid && current.sessionId === lifecycle.sessionId && current.socketPath === lifecycle.socketPath) {
        await unlink(path.join(deps.config.dataDir, 'sessions', id, 'lifecycle.json')).catch(error => {
          if (!errno(error, 'ENOENT')) throw error;
        });
        if (path.dirname(lifecycle.socketPath) === tmpdir() && /^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(lifecycle.socketPath))) {
          await unlink(lifecycle.socketPath).catch(error => { if (!errno(error, 'ENOENT')) throw error; });
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

