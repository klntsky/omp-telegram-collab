import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import type { WorktreeTarget } from '../omp.js';
import { type RegistryHost, type DurableBinding, type ManagedHost, type HostActivity } from './types.js';
import { privateFile, writeBinding, readHeader } from './files.js';
import { errno, record } from './values.js';
import { childEnvironment } from './environment.js';
interface WorktreeDependencies {
  readonly config: AppConfig;
  reserveSession(sessionId?: string, beforeMutation?: () => Promise<void>): Promise<{ bind(id: string): void; release(): void }>;
  assertActive(): void;
  readonly closed: boolean;
  readonly stopping: Map<string, Promise<void>>;
  hostActivity(id: string): HostActivity;
  readonly pending: Map<string, Promise<HostBinding>>;
  presetLaunch(session: TopicSession): Promise<{ overlay: Record<string, unknown>; args: string[]; preset?: string }>;
  readonly managed: Map<string, ManagedHost | null>;
  list(deadline: number): Promise<RegistryHost[]>;
  shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void>;
  prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }>;
  validateCwd(cwd: string): Promise<void>;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  stopIdle(session: TopicSession): Promise<boolean>;
  readonly skillProcesses: Set<ChildProcess>;
}

// This owner keeps the complete worktree transaction and its cleanup together.
export interface RuntimeWorktree {
  worktree(session: TopicSession, branch?: string, beforeMutation?: () => Promise<void>): Promise<string>;
  topicTitleStatus(session: TopicSession): Promise<{ worktree: boolean; branch?: string }>;
  inspectWorktree(session: TopicSession): Promise<WorktreeTarget | undefined>;
  deleteWorktree(session: TopicSession, target: WorktreeTarget, beforeMutation: () => Promise<void>): Promise<void>;
}

export function createWorktree(deps: WorktreeDependencies): RuntimeWorktree {

  function git(cwd: string, args: string[], missingRepository = false): Promise<string | undefined> {
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    const env = Object.fromEntries(Object.entries(childEnvironment()).filter(([key]) => !key.startsWith('GIT_')));
    execFile('git', args, {
      cwd, env: { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      timeout: deps.config.omp.startupTimeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (!error) resolve(stdout.trim());
      else if (missingRepository && error.code === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(stderr)) resolve(undefined);
      else reject(error);
    });
    return promise;
  }

  function contains(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  function protectPaths(target: WorktreeTarget, pin: DurableBinding): void {
    const protectedPaths = [deps.config.dataDir, deps.config.configPath, pin.sessionFile, target.gitDir, target.commonDir,
      ...deps.config.instances.flatMap(instance => [instance.defaultDir, ...instance.chats.flatMap(chat =>
        (chat.folder_options ?? []).map(option => path.resolve(instance.defaultDir, option)))])];
    for (const configured of protectedPaths) {
      if (contains(target.path, path.resolve(configured))) throw new Error(`Worktree contains a protected path: ${configured}`);
      // An absent configured file can still have a symlinked parent.
      let existing = path.resolve(configured);
      while (true) {
        try {
          if (contains(target.path, realpathSync(existing))) throw new Error(`Worktree contains a protected path: ${configured}`);
          break;
        } catch (error) {
          if (!errno(error, 'ENOENT')) throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          existing = parent;
        }
      }
    }
  }

  async function inspectBinding(pin: DurableBinding): Promise<WorktreeTarget | undefined> {
    if (pin.removedWorktree) return undefined;
    const directory = await lstat(pin.cwd);
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(pin.cwd) !== pin.cwd) {
      throw new Error(`Worktree directory identity changed: ${pin.cwd}`);
    }
    const bare = await git(pin.cwd, ['rev-parse', '--is-bare-repository'], true);
    if (bare === undefined || bare === 'true') return undefined;
    const metadata = await git(pin.cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
    const [root, rawGitDir, rawCommonDir] = metadata!.split('\n');
    if (!root || !rawGitDir || !rawCommonDir || root !== pin.cwd) return undefined;
    const gitDir = await realpath(rawGitDir);
    const commonDir = await realpath(rawCommonDir);
    if (gitDir === commonDir) return undefined;
    const registrations = (await git(commonDir, ['worktree', 'list', '--porcelain', '-z']))!.split('\0');
    if (registrations.filter(field => field === `worktree ${root}`).length !== 1) {
      throw new Error('Worktree Git registration identity changed');
    }
    const target = { path: root, gitDir, commonDir, sessionId: pin.sessionId, dev: directory.dev, ino: directory.ino };
    protectPaths(target, pin);
    return target;
  }

  async function canSkipConfirmation(cwd: string): Promise<boolean> {
    if (await git(cwd, ['status', '--porcelain', '--untracked-files=all'])) return false;
    const branch = await git(cwd, ['branch', '--show-current']);
    if (!branch) return false;
    const remotes = (await git(cwd, ['remote']))!.split('\n').filter(Boolean);
    // Query the server because remote-tracking refs can outlive a deleted remote branch.
    for (const remote of remotes) {
      const heads = await git(cwd, ['ls-remote', '--heads', '--refs', remote, `refs/heads/${branch}`]);
      if (heads!.split('\n').some(line => line.split('\t')[1] === `refs/heads/${branch}`)) return true;
    }
    return false;
  }

  async function inspectWorktree(session: TopicSession): Promise<WorktreeTarget | undefined> {
    deps.assertActive();
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (session.runtime.kind !== 'managed') return undefined;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
    const pin = await deps.readManagedBinding(session);
    const target = pin && await inspectBinding(pin);
    return target ? { ...target, skipConfirmation: await canSkipConfirmation(target.path) } : undefined;
  }

  async function deleteWorktree(session: TopicSession, target: WorktreeTarget, beforeMutation: () => Promise<void>): Promise<void> {
    const assertBoundary = (operation?: Promise<void>) => {
      deps.assertActive();
      if (deps.closed || deps.stopping.get(session.id) !== operation || deps.pending.has(session.id)) throw new Error('OMP runtime is stopping');
      if (session.runtime.kind !== 'managed' || session.status !== 'closed') throw new Error('Worktree cleanup requires a closed managed session');
      const activity = deps.hostActivity(session.id);
      if (activity.busy || activity.leases) throw new Error('OMP host is busy; worktree cleanup refused');
    };
    await beforeMutation();
    assertBoundary();
    if (!await deps.stopIdle(session)) throw new Error('OMP host has not stopped; worktree cleanup refused');
    assertBoundary();
    // Guarded retirement must finish before installing the deletion fence it would wait on.
    const operation = Promise.resolve().then(async () => {
      const pin = await deps.readManagedBinding(session);
      const current = pin && await inspectBinding(pin);
      if (!pin || !current || current.path !== target.path || current.gitDir !== target.gitDir ||
          current.commonDir !== target.commonDir || current.sessionId !== target.sessionId ||
          current.dev !== target.dev || current.ino !== target.ino) throw new Error('Worktree identity changed before deletion');
      const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
      for (const host of hosts) {
        const cwd = await realpath(host.cwd);
        if (host.sessionId === target.sessionId || contains(target.path, cwd) || contains(cwd, target.path)) {
          throw new Error('An OMP host still uses this worktree');
        }
      }
      if (target.skipConfirmation && !await canSkipConfirmation(target.path)) {
        throw new Error('Worktree is no longer clean with a branch on a remote. Request deletion again to confirm.');
      }
      await beforeMutation();
      assertBoundary(operation);
      for (const [id, host] of deps.managed) {
        if (!host || host.exited) continue;
        if (id === session.id || host.sessionId === target.sessionId) throw new Error('OMP host has not stopped; worktree cleanup refused');
        if (host.cwd) {
          const cwd = realpathSync(host.cwd);
          if (contains(target.path, cwd) || contains(cwd, target.path)) throw new Error('Another managed OMP host uses this worktree');
        }
      }
      const directory = lstatSync(target.path);
      if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(target.path) !== target.path ||
          directory.dev !== target.dev || directory.ino !== target.ino) throw new Error(`Worktree directory identity changed: ${target.path}`);
      protectPaths(target, pin);
      // Git owns dirty/locked-worktree refusal and exact-path registration updates.
      // https://github.com/git/git/blob/master/builtin/worktree.c (remove_worktree)
      await git(target.commonDir, ['worktree', 'remove', '--', target.path]);
      // Persist the applied outcome even if authorization changes while Git finishes.
      await writeBinding(path.join(deps.config.dataDir, 'sessions', session.id), { ...pin, removedWorktree: true });
    }).finally(() => {
      if (deps.stopping.get(session.id) === operation) deps.stopping.delete(session.id);
    });
    deps.stopping.set(session.id, operation);
    return operation;
  }

  async function worktree(session: TopicSession, branch?: string, beforeMutation?: () => Promise<void>): Promise<string> {
    if (session.runtime.kind !== 'managed') throw new Error('Attached OMP sessions cannot switch worktrees');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance path is not configured');
    const reservation = await deps.reserveSession(session.id, beforeMutation);
    try { return await switchWorktree(session, branch, beforeMutation); }
    finally { reservation.release(); }
  }

  async function switchWorktree(session: TopicSession, branch?: string, beforeMutation?: () => Promise<void>): Promise<string> {
    deps.assertActive();
    if (session.runtime.kind !== 'managed') throw new Error('Attached OMP sessions cannot switch worktrees');
    if (session.status !== 'open') throw new Error('Session closed');
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance path is not configured');
    const activity = deps.hostActivity(session.id);
    if (activity.busy || activity.leases || deps.pending.has(session.id)) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
    // Fence before the first await: even a dormant session's history must have
    // only one writer while native /worktree relocates it.
    const operation = Promise.resolve().then(async () => {
      const { dir, pin } = await deps.prepare(session);
      const known = deps.managed.get(session.id);
      if (known && known.sessionId !== pin.sessionId) throw new Error('Managed OMP history identity changed');
      const host = known && !known.exited ? known : { sessionId: pin.sessionId, cwd: pin.cwd, exited: false, retiring: false };
      await beforeMutation?.();
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      if (deps.hostActivity(session.id).busy || deps.hostActivity(session.id).leases) {
        throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
      }
      // Retirement owns registry and offline lifecycle/PID checks. A missing
      // registry entry alone must never authorize another history writer.
      await deps.shutdown(session.id, host, 'worktree');
      if (!host.exited) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
      await beforeMutation?.();
      const launch = await deps.presetLaunch(session);
      const config = path.join(dir, 'worktree.yml');
      // RPC needs the session's model settings, but no Collab room or managed
      // host lifecycle. The final host starts only after relocation completes.
      await privateFile(config, JSON.stringify({
        ...launch.overlay, collab: { autoStart: false }, startup: { checkUpdate: false, setupWizard: false },
      }));
      await beforeMutation?.();
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      const result = await worktreeRpc(config, pin, launch.args, branch);
      const state = result.state;
      if (state.sessionId !== pin.sessionId || typeof state.sessionFile !== 'string') {
        throw new Error('Native OMP worktree returned an invalid session identity');
      }
      const sessionFile = await realpath(state.sessionFile);
      const header = await readHeader(sessionFile);
      const cwd = await realpath(header.cwd);
      await deps.validateCwd(cwd);
      if (header.id !== pin.sessionId || header.cwd !== cwd) throw new Error('Native OMP worktree history identity changed');
      await beforeMutation?.();
      await chmod(sessionFile, 0o600);
      await beforeMutation?.();
      await writeBinding(dir, { ...pin, cwd, sessionFile });
      session.cwd = cwd;
      if (cwd === pin.cwd) throw new Error(result.text || 'OMP worktree command did not move the session');
      return result.text;
    });
    deps.stopping.set(session.id, operation.then(() => undefined, () => undefined));
    try { return await operation; }
    finally { deps.stopping.delete(session.id); }
  }

  async function worktreeRpc(config: string, pin: DurableBinding, args: string[], branch?: string): Promise<{ text: string; state: Record<string, unknown> }> {
    const child = spawn(deps.config.omp.executable, [
      ...args, '--mode', 'rpc', '--resume', pin.sessionFile,
      '--cwd', pin.cwd, '--config', config, '--no-title',
    ], { cwd: pin.cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    deps.skillProcesses.add(child);
    let buffer = '';
    let diagnostics = '';
    const outputs: string[] = [];
    let state: Record<string, unknown> | undefined;
    let failure: Error | undefined;
    const { promise: completion, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      failure = new Error('OMP worktree command timed out');
      child.kill('SIGKILL');
    }, deps.config.omp.startupTimeoutMs);
    child.once('error', error => { failure = error; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', part => { diagnostics += part; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      buffer += part;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === 'command_output' && typeof frame.text === 'string') outputs.push(frame.text);
          if (frame.type !== 'response') continue;
          if (frame.success !== true) throw new Error(typeof frame.error === 'string' ? frame.error : 'OMP worktree RPC failed');
          if (frame.id === 'worktree') {
            if (!record(frame.data) || frame.data.agentInvoked !== false) throw new Error('OMP worktree unexpectedly invoked an agent');
            child.stdin.write(`${JSON.stringify({ id: 'state', type: 'get_state' })}\n`);
          } else if (frame.id === 'state') {
            if (!record(frame.data)) throw new Error('Invalid OMP worktree state');
            state = frame.data;
            child.stdin.end();
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          child.stdin.end();
        }
      }
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) {
        const text = outputs.join('\n') || diagnostics;
        if (text && !failure.message.includes(text)) failure.message += `\n${text}`;
        reject(failure);
      }
      else if (code !== 0 || !state) reject(new Error(outputs.join('\n') || diagnostics || 'OMP worktree RPC exited without session state'));
      else resolve();
    });
    child.stdin.on('error', error => { failure ??= error; });
    child.stdin.write(`${JSON.stringify({ id: 'worktree', type: 'prompt', message: `/worktree${branch ? ` ${branch}` : ''}` })}\n`);
    try {
      await completion;
      return { text: outputs.join('\n'), state: state! };
    } finally {
      deps.skillProcesses.delete(child);
    }
  }

  async function topicTitleStatus(session: TopicSession): Promise<{ worktree: boolean; branch?: string }> {
    let cwd = session.cwd;
    if (session.runtime.kind === 'attached') {
      const runtime = session.runtime;
      const hosts = await deps.list(Date.now() + deps.config.omp.startupTimeoutMs);
      const host = hosts.find(value => value.instanceId === runtime.instanceId && value.sessionId === runtime.sessionId);
      if (!host) throw new Error('Attached OMP host is not available');
      cwd = host.cwd;
    }
    const metadata = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], true);
    if (metadata === undefined) return { worktree: false };
    const [gitDir, commonDir] = metadata.split('\n');
    const worktree = gitDir !== commonDir;
    const branch = await git(cwd, ['branch', '--show-current']);
    if (!branch) return { worktree };
    const remoteHeads = (await git(cwd, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes']))!
      .split('\n').map(line => line.split(' '));
    const remoteHead = remoteHeads.find(([ref, target]) => ref === 'refs/remotes/origin/HEAD' && target)
      ?? remoteHeads.find(([ref, target]) => ref?.endsWith('/HEAD') && target);
    let defaultBranch = remoteHead?.[1]?.replace(/^refs\/remotes\/[^/]+\//, '');
    if (!defaultBranch) {
      const branches = (await git(cwd, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads']))!.split('\n').filter(Boolean);
      const configured = await git(cwd, ['config', '--list']);
      const initialBranch = configured?.split('\n').findLast(line => line.startsWith('init.defaultbranch='))?.slice('init.defaultbranch='.length);
      defaultBranch = initialBranch && (branches.includes(initialBranch) || branch === initialBranch) ? initialBranch
        : branches.find(value => value === 'main') ?? branches.find(value => value === 'master')
          ?? (branches.length === 1 ? branches[0] : undefined);
    }
    return { worktree, ...(branch !== defaultBranch ? { branch } : {}) };
  }

  return { worktree, topicTitleStatus, inspectWorktree, deleteWorktree };
}

