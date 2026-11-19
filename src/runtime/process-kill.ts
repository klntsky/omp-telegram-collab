import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type ManagedHost } from './types.js';
import { procIdentity, belongsTo } from './process.js';
import { errno, delay } from './values.js';
import { readLaunch, killLaunch } from './launch-record.js';
interface ProcessKillDependencies {
  readonly config: AppConfig;
  readonly managed: Map<string, ManagedHost | null>;
  forgetActivity(id: string): void;
  list(deadline: number): Promise<RegistryHost[]>;
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
    if (session.runtime.kind === 'managed') {
      const root = path.join(deps.config.dataDir, 'sessions', id);
      if (await readLaunch(root)) await killLaunch(root);
      const owned = deps.managed.get(id);
      if (owned) { owned.exited = true; owned.retiring = false; }
      deps.managed.delete(id);
      deps.forgetActivity(id);
      return;
    }
    const target = session.runtime;
    const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
    const matches = hosts.filter(host => host.instanceId === target.instanceId);
    if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
    const host = matches[0];
    if (host) {
      if (host.sessionId !== target.sessionId) throw new Error('Attached OMP session identity changed');
      const cwd = await realpath(host.cwd);
      if (cwd !== session.cwd) throw new Error('OMP host does not belong to this session working directory');
      const executable = await configuredExecutable();
      await killProcess(host.pid, cwd, executable, async () => {
        const current = (await deps.list(Date.now() + 5000)).find(value => value.instanceId === host.instanceId);
        if (!current || current.pid !== host.pid || current.sessionId !== host.sessionId ||
            current.generation !== host.generation || current.cwd !== host.cwd) {
          // Keep both snapshots on the original refusal so its owner can diagnose
          // a registry transition without weakening the process-identity fence.
          throw Object.assign(new Error('OMP host identity changed before kill'), {
            expectedHost: host,
            observedHost: current ?? null,
          });
        }
      });
    }
    deps.forgetActivity(id);
  }

  return { killSession };
}

