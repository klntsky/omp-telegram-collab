import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import type { WorktreeCleanupGuard, WorktreeTarget } from '../omp.js';
import type { DurableBinding, HostActivity, HostLifecycle, ManagedHost, RegistryHost } from './types.js';
import { writeBinding } from './files.js';
import { procIdentity } from './process.js';

interface CleanupDependencies {
  config: AppConfig;
  readonly closed: boolean;
  assertActive(): void;
  acquire(): Promise<void>;
  stopping: Map<string, Promise<void>>;
  pending: Map<string, Promise<HostBinding>>;
  managed: Map<string, ManagedHost | null>;
  hostActivity(id: string): HostActivity;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  list(deadline: number): Promise<RegistryHost[]>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
}

export interface RuntimeWorktreeCleanup {
  inspectWorktree(session: TopicSession): Promise<WorktreeTarget | undefined>;
  deleteWorktree(session: TopicSession, target: WorktreeTarget, guard: WorktreeCleanupGuard): Promise<void>;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function createWorktreeCleanup(deps: CleanupDependencies): RuntimeWorktreeCleanup {
  function git(cwd: string, args: string[], missingRepository = false): Promise<string | undefined> {
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    execFile('git', args, {
      cwd, env: { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      timeout: deps.config.omp.startupTimeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (!error) resolve(stdout);
      else if (missingRepository && error.code === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(stderr)) resolve(undefined);
      else reject(error);
    });
    return promise;
  }

  async function identity(directory: string): Promise<{ dev: number; ino: number }> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error(`Worktree directory identity changed: ${directory}`);
    }
    return { dev: stat.dev, ino: stat.ino };
  }

  async function inspect(session: TopicSession): Promise<WorktreeTarget | undefined> {
    deps.assertActive();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    if (session.runtime.kind !== 'managed') return undefined;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance path is not configured');
    const pin = await deps.readManagedBinding(session);
    if (!pin || pin.removedWorktree) return undefined;
    const directory = await identity(pin.cwd);
    const bareRepository = await git(pin.cwd, ['rev-parse', '--is-bare-repository'], true);
    if (bareRepository === undefined || bareRepository.trim() === 'true') return undefined;
    const metadata = await git(pin.cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--is-bare-repository'], true);
    if (metadata === undefined) return undefined;
    const [root, gitDir, commonDir, bare] = metadata.trimEnd().split('\n');
    if (!root || !gitDir || !commonDir || bare !== 'false' || root !== pin.cwd || gitDir === commonDir) return undefined;
    const identities = { directory, gitDir: await identity(gitDir), commonDir: await identity(commonDir) };
    if (contains(root, commonDir) || contains(root, gitDir)) throw new Error('Worktree contains protected Git metadata');
    const registrations = (await git(commonDir, ['worktree', 'list', '--porcelain', '-z']))!.split('\0');
    const roots = registrations.filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
    const registered = [];
    for (const candidate of roots) {
      try {
        if (await realpath(candidate) === root) registered.push(candidate);
      } catch (error) {
        if (candidate === root || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if (registered.length !== 1 || registered[0] !== root) throw new Error('Worktree Git registration identity changed');
    const protectedPaths = [deps.config.dataDir, deps.config.configPath, pin.sessionFile,
      ...deps.config.instances.flatMap(instance => [instance.defaultDir, ...instance.chats.flatMap(chat => (chat.folder_options ?? []).map(option => path.resolve(instance.defaultDir, option)))])];
    for (const configured of protectedPaths) {
      if (contains(root, path.resolve(configured))) throw new Error(`Worktree contains a protected path: ${configured}`);
      // Config paths may name an absent file. Their existing parent still reveals aliases.
      let existing = path.resolve(configured);
      while (true) {
        try {
          const canonical = await realpath(existing);
          if (contains(root, canonical)) throw new Error(`Worktree contains a protected path: ${configured}`);
          break;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          existing = parent;
        }
      }
    }
    deps.assertActive();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    return { path: root, gitDir, commonDir, sessionId: pin.sessionId, identities };
  }

  async function inspectWorktree(session: TopicSession): Promise<WorktreeTarget | undefined> {
    if (deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    const target = await inspect(session);
    if (deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    return target;
  }

  function deleteWorktree(session: TopicSession, target: WorktreeTarget, guard: WorktreeCleanupGuard): Promise<void> {
    if (deps.closed || deps.stopping.has(session.id) || deps.pending.has(session.id)) return Promise.reject(new Error('OMP runtime is stopping'));
    // Install the fence before the first await. Public stop would wait on our own fence.
    const operation = Promise.resolve().then(async () => {
      const assertCurrent = () => {
        deps.assertActive();
        guard.assertCurrent();
        if (deps.closed || deps.stopping.get(session.id) !== operation || deps.pending.has(session.id)) throw new Error('OMP runtime is stopping');
        if (session.runtime.kind !== 'managed' || session.status !== 'closed') throw new Error('Worktree cleanup requires a closed managed session');
      };
      const observed = async <T>(promise: Promise<T>): Promise<T> => {
        const result = await promise;
        assertCurrent();
        return result;
      };
      const recheck = async () => {
        const current = await observed(inspect(session));
        if (!current || JSON.stringify(current) !== JSON.stringify(target)) throw new Error('Worktree identity changed before deletion');
      };
      assertCurrent();
      await observed(deps.acquire());
      await recheck();
      const activity = deps.hostActivity(session.id);
      if (activity.busy || activity.leases) throw new Error('OMP host is busy; worktree cleanup refused');
      const pin = await observed(deps.readManagedBinding(session));
      if (!pin || pin.sessionId !== target.sessionId) throw new Error('Managed OMP binding identity changed');
      const host = deps.managed.get(session.id);
      const lifecycle = await observed(deps.lifecycle(session.id));
      if (lifecycle && lifecycle.sessionId !== pin.sessionId) throw new Error('Managed OMP lifecycle identity changed');
      const pids = new Set([lifecycle?.pid, lifecycle?.supervisorPid, host?.identity?.pid, host?.retirement?.pid, host?.process?.pid]
        .filter((pid): pid is number => pid !== undefined));
      for (const pid of pids) {
        const identity = await observed(procIdentity(pid));
        if (identity && identity.state !== 'Z' && identity.state !== 'X') throw new Error('OMP host has not stopped; worktree cleanup refused');
      }
      if (host?.retiring && !host.retirement && !host.identity && !host.process) throw new Error('OMP host retirement is unconfirmed; worktree cleanup refused');
      const hosts = await observed(deps.list(Date.now() + deps.config.omp.startupTimeoutMs));
      for (const live of hosts) {
        const cwd = await observed(realpath(live.cwd));
        if (live.sessionId === target.sessionId || contains(target.path, cwd) || contains(cwd, target.path)) throw new Error('An OMP host still uses this worktree');
      }
      for (const [id, managed] of deps.managed) {
        if (id === session.id || !managed || managed.exited || !managed.cwd) continue;
        const cwd = await observed(realpath(managed.cwd));
        if (contains(target.path, cwd) || contains(cwd, target.path)) throw new Error('Another managed OMP host uses this worktree');
      }
      await observed(guard.beforeMutation());
      await recheck();
      // No await separates these final identity checks from launching the exact-path Git removal.
      for (const [directory, expected] of [
        [target.path, target.identities.directory],
        [target.gitDir, target.identities.gitDir],
        [target.commonDir, target.identities.commonDir],
      ] as const) {
        const current = lstatSync(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(directory) !== directory ||
            current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`Worktree directory identity changed: ${directory}`);
      }
      assertCurrent();
      // Git owns dirty/locked-worktree refusal and registry updates. Never force or recursively remove.
      // https://git-scm.com/docs/git-worktree#Documentation/git-worktree.txt-remove
      await git(target.commonDir, ['worktree', 'remove', '--', target.path]);
      // Record an applied irreversible outcome even if the topic reopened while Git was finishing.
      let absenceError: unknown;
      try {
        await lstat(target.path);
        absenceError = new Error(`Worktree path exists after Git removal: ${target.path}`);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) absenceError = error;
      }
      try {
        await writeBinding(path.join(deps.config.dataDir, 'sessions', session.id), {
          ...pin, removedWorktree: { path: target.path, gitDir: target.gitDir, commonDir: target.commonDir, directory: target.identities.directory },
        });
      } catch (error) {
        if (absenceError !== undefined) throw new AggregateError([absenceError, error],
          `${absenceError instanceof Error ? absenceError.message : String(absenceError)}\n${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      if (absenceError !== undefined) throw absenceError;
    }).finally(() => {
      if (deps.stopping.get(session.id) === operation) deps.stopping.delete(session.id);
    });
    deps.stopping.set(session.id, operation);
    return operation;
  }

  return { inspectWorktree, deleteWorktree };
}
