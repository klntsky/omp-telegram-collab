import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type RegistryHost, type DurableBinding, type ManagedHost, type HostActivity } from './types.js';
import { writeBinding, readHeader } from './files.js';
import { record } from './values.js';
interface WorktreeDependencies {
  readonly config: AppConfig;
  reserveSession(sessionId?: string, beforeMutation?: () => Promise<void>): Promise<{ bind(id: string): void; release(): void }>;
  assertActive(): void;
  readonly closed: boolean;
  readonly stopping: Map<string, Promise<void>>;
  hostActivity(id: string): HostActivity;
  readonly pending: Map<string, Promise<HostBinding>>;
  ensure(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
  readonly managed: Map<string, ManagedHost | null>;
  list(deadline: number): Promise<RegistryHost[]>;
  shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void>;
  prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }>;
  validateCwd(cwd: string): Promise<void>;
  readonly skillProcesses: Set<ChildProcess>;
}

// This owner keeps the complete worktree transaction and its cleanup together.
export interface RuntimeWorktree {
  worktree(session: TopicSession, branch?: string, beforeMutation?: () => Promise<void>): Promise<string>;
  topicTitleStatus(session: TopicSession): Promise<{ worktree: boolean; branch?: string }>;
}

export function createWorktree(deps: WorktreeDependencies): RuntimeWorktree {

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
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (!deps.config.instances.some(instance => instance.id === session.instanceId)) throw new Error('Instance path is not configured');
    const activity = deps.hostActivity(session.id);
    if (activity.busy || activity.leases || deps.pending.has(session.id)) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
    await deps.ensure(session, beforeMutation);
    const host = deps.managed.get(session.id);
    if (!host) throw new Error('Managed OMP host is not available');
    const registered = (await deps.list(Date.now() + deps.config.omp.startupTimeoutMs)).find(value => value.sessionId === host.sessionId);
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (deps.hostActivity(session.id).busy || deps.hostActivity(session.id).leases || registered?.busy === true) {
      throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
    }
    const operation = (async () => {
      await beforeMutation?.();
      await deps.shutdown(session.id, host, 'worktree');
      if (!host.exited) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
      await beforeMutation?.();
      const { dir, pin } = await deps.prepare(session);
      await beforeMutation?.();
      const result = await worktreeRpc(dir, pin, branch);
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
    })();
    deps.stopping.set(session.id, operation.then(() => undefined, () => undefined));
    try { return await operation; }
    finally { deps.stopping.delete(session.id); }
  }

  async function worktreeRpc(dir: string, pin: DurableBinding, branch?: string): Promise<{ text: string; state: Record<string, unknown> }> {
    const child = spawn(deps.config.omp.executable, [
      ...deps.config.omp.args, '--mode', 'rpc', '--resume', pin.sessionFile,
      '--cwd', pin.cwd, '--config', path.join(dir, 'runtime.yml'), '--no-title',
    ], { cwd: pin.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const git = (args: string[], missingRepository = false): Promise<string | undefined> => {
      const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
      execFile('git', args, {
        cwd,
        env: { ...process.env, LC_ALL: 'C' },
        timeout: deps.config.omp.startupTimeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (!error) resolve(stdout.trim());
        else if (missingRepository && error.code === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(stderr)) resolve(undefined);
        else reject(error);
      });
      return promise;
    };
    const metadata = await git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], true);
    if (metadata === undefined) return { worktree: false };
    const [gitDir, commonDir] = metadata.split('\n');
    const worktree = gitDir !== commonDir;
    const branch = await git(['branch', '--show-current']);
    if (!branch) return { worktree };
    const remoteHeads = (await git(['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes']))!
      .split('\n').map(line => line.split(' '));
    const remoteHead = remoteHeads.find(([ref, target]) => ref === 'refs/remotes/origin/HEAD' && target)
      ?? remoteHeads.find(([ref, target]) => ref?.endsWith('/HEAD') && target);
    let defaultBranch = remoteHead?.[1]?.replace(/^refs\/remotes\/[^/]+\//, '');
    if (!defaultBranch) {
      const branches = (await git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads']))!.split('\n').filter(Boolean);
      const configured = await git(['config', '--list']);
      const initialBranch = configured?.split('\n').findLast(line => line.startsWith('init.defaultbranch='))?.slice('init.defaultbranch='.length);
      defaultBranch = initialBranch && (branches.includes(initialBranch) || branch === initialBranch) ? initialBranch
        : branches.find(value => value === 'main') ?? branches.find(value => value === 'master')
          ?? (branches.length === 1 ? branches[0] : undefined);
    }
    return { worktree, ...(branch !== defaultBranch ? { branch } : {}) };
  }

  return { worktree, topicTitleStatus };
}

