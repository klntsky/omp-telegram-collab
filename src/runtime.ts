import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, HostBinding, TopicSession } from '../shared/contracts.js';
import { parseCollabLink } from './vendor/link.js';
import { findInstance, refreshTermination } from './config.js';
import { miniAppInterruptionAuthor } from '../shared/interruption.js';
import { withCancellation } from './cancellation.js';

export class SessionCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`OMP session limit (${limit}) reached. Ask in the topic to approve more capacity, then rejoin.`);
    this.name = 'SessionCapacityError';
  }
}

export class SessionTitleUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTitleUnsupportedError';
  }
}

interface RegistryHost {
  instanceId: string;
  sessionId: string;
  generation: number;
  pid: number;
  cwd: string;
  access: 'view' | 'control';
  relayConnected: boolean;
  busy?: boolean;
}

interface DurableBinding {
  version: 1;
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

interface ManagedHost {
  process?: ChildProcess;
  binding?: HostBinding;
  sessionId: string;
  exited: boolean;
  retiring: boolean;
  failure?: string;
  retirement?: { pid: number; start: string; socketPath: string; error?: unknown };
}

interface HostActivity { busy: boolean; awaitingTurn: boolean; leases: number; lastUsed: number }
interface HostLifecycle { pid: number; supervisorPid: number; sessionId: string; socketPath: string; retiring?: boolean; modelPresets?: 2; skills?: boolean; worktree?: boolean; sessionTitles?: boolean; retirement?: 1 }

const FORBIDDEN_ARGS: Record<string, true> = {
  '--session': true, '-s': true, '--session-dir': true, '--resume': true, '-r': true,
  '--continue': true, '-c': true, '--no-session': true, '--restore': true, '--fork': true,
  '--mode': true, '--print': true, '-p': true, '--goal': true, '--cwd': true,
  '--help': true, '-h': true, '--version': true,
};

const OMP_STRING_ARGS: Record<string, true> = {
  '--cwd': true, '--config': true, '--add-dir': true, '--mode': true, '--fork': true,
  '--provider': true, '--model': true, '--smol': true, '--slow': true, '--goal': true,
  '--prewalk-into': true, '--plan-yolo-into': true, '--max-time': true, '--warn-cost': true,
  '--max-cost': true, '--service-tier': true, '--api-key': true, '--system-prompt': true,
  '--system-prompt-template': true, '--append-system-prompt': true, '--provider-session-id': true,
  '--prompt-cache-key': true, '--session-dir': true, '--models': true, '--tools': true,
  '--thinking': true, '--export': true, '--hook': true, '--extension': true, '-e': true,
  '--trusted-extension': true, '--plugin-dir': true, '--skills': true, '--approval-mode': true,
  '--profile': true, '--alias': true,
};
const PRESET_MODEL_ARGS: Record<string, true> = {
  '--provider': true, '--model': true, '--smol': true, '--slow': true, '--models': true, '--thinking': true,
};

function ompArguments(args: string[]): { flag: string; value?: string; args: string[] }[] {
  const result: { flag: string; value?: string; args: string[] }[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      result.push({ flag: arg, args: args.slice(index) });
      break;
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (equals >= 0) {
      result.push({ flag, value: arg.slice(equals + 1), args: [arg] });
    } else if (Object.hasOwn(OMP_STRING_ARGS, flag) && index + 1 < args.length) {
      const value = args[++index]!;
      result.push({ flag, value, args: [arg, value] });
    } else {
      result.push({ flag, args: [arg] });
    }
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


const RETIREMENT_GRANT = /^retirement-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.request$/;

async function procIdentity(pid: number): Promise<{ parent: number; group: number; start: string; state: string } | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]!, state: fields[0]! };
  } catch (error) {
    if (errno(error, 'ENOENT') || errno(error, 'ESRCH')) return null;
    throw error;
  }
}

async function belongsTo(pid: number, parent: number): Promise<boolean> {
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (pid === parent) return true;
    const info = await procIdentity(pid);
    if (!info || info.parent === pid) return false;
    pid = info.parent;
  }
  return false;
}

async function privateFile(file: string, contents: string, exclusive = false): Promise<void> {
  const handle = await open(file, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeBinding(dir: string, binding: DurableBinding): Promise<void> {
  const temporary = path.join(dir, `binding.${randomUUID()}.tmp`);
  try {
    await privateFile(temporary, `${JSON.stringify(binding)}\n`, true);
    await rename(temporary, path.join(dir, 'binding.json'));
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (!errno(error, 'ENOENT')) throw error;
    });
  }
}

async function readHeader(file: string): Promise<{ id: string; cwd: string }> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed history must be a regular file');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    let header = JSON.parse(lines[0] || '{}') as Record<string, unknown>;
    if (header.type === 'title' && header.v === 1) header = JSON.parse(lines[1] || '{}') as Record<string, unknown>;
    if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string') {
      throw new Error('Unsupported managed OMP session history format');
    }
    return { id: header.id, cwd: header.cwd };
  } finally {
    await handle.close();
  }
}

export class OmpRuntime {
  readonly #config: AppConfig;
  readonly #pending = new Map<string, Promise<HostBinding>>();
  readonly #managed = new Map<string, ManagedHost | null>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #killing = new Map<string, Promise<void>>();
  readonly #skillProcesses = new Set<ChildProcess>();
  readonly #skillCatalogs = new Map<string, {
    expiresAt: number;
    catalog?: Array<{ name: string; description: string }>;
    error?: unknown;
  }>();
  readonly #skillDiscovery = new Map<string, {
    promise: Promise<Array<{ name: string; description: string }>>;
    controller: AbortController;
    consumers: number;
  }>();
  #closed = false;
  #closing?: Promise<void>;
  #lock?: DatabaseSync;
  #acquiring?: Promise<void>;
  readonly #activity = new Map<string, HostActivity>();
  #admission = Promise.resolve();
  readonly #idleTimer: NodeJS.Timeout;
  #sessionLimit: number;
  #discovered = false;

  constructor(config: AppConfig) {
    if (!Number.isInteger(config.omp.maxSessions) || config.omp.maxSessions < 1 || !Number.isFinite(config.omp.startupTimeoutMs) || config.omp.startupTimeoutMs < 1) {
      throw new Error('Invalid OMP runtime limits');
    }
    for (const arg of config.omp.args) {
      const flag = arg.split('=', 1)[0]!;
      if (Object.hasOwn(FORBIDDEN_ARGS, flag) || flag.startsWith('--from-')) throw new Error(`OMP argument ${flag} conflicts with managed hosting`);
    }
    this.#config = config;
    this.#sessionLimit = config.omp.maxSessions;
    this.#idleTimer = setInterval(() => { void this.retireIdle().catch(() => {}); }, 60000);
    this.#idleTimer.unref();
  }
  #assertActive(): void {
    if (refreshTermination(this.#config)) {
      throw new Error('The service got terminated, only admin can resume it (remove terminated: true from the config)');
    }
  }
  getSessionLimit(): number { return this.#sessionLimit; }
  setSessionLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid OMP session limit');
    this.#sessionLimit = limit;
  }
  increaseSessionLimit(expectedLimit: number): boolean {
    this.#assertActive();
    if (this.#closed || this.#sessionLimit !== expectedLimit || !Number.isSafeInteger(expectedLimit * 2)) return false;
    this.#sessionLimit = expectedLimit * 2;
    return true;
  }
  async topicTitleStatus(session: TopicSession): Promise<{ worktree: boolean; branch?: string }> {
    let cwd = this.#sessionCwd(session);
    if (session.runtime.kind === 'attached') {
      const runtime = session.runtime;
      const hosts = await this.#list(Date.now() + this.#config.omp.startupTimeoutMs);
      const host = hosts.find(value => value.instanceId === runtime.instanceId && value.sessionId === runtime.sessionId);
      if (!host) throw new Error('Attached OMP host is not available');
      cwd = host.cwd;
    }
    const git = (args: string[], missingRepository = false): Promise<string | undefined> => {
      const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
      execFile('git', args, {
        cwd,
        env: { ...process.env, LC_ALL: 'C' },
        timeout: this.#config.omp.startupTimeoutMs,
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

  async worktree(session: TopicSession, branch?: string): Promise<string> {
    this.#assertActive();
    if (session.runtime.kind !== 'managed') throw new Error('Attached OMP sessions cannot switch worktrees');
    if (this.#closed || this.#stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (!Object.hasOwn(this.#config.instances, session.instancePath)) throw new Error('Instance path is not configured');
    const activity = this.#hostActivity(session.id);
    if (activity.busy || activity.leases || this.#pending.has(session.id)) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
    await this.ensure(session);
    const host = this.#managed.get(session.id);
    if (!host) throw new Error('Managed OMP host is not available');
    const registered = (await this.#list(Date.now() + this.#config.omp.startupTimeoutMs)).find(value => value.sessionId === host.sessionId);
    if (this.#closed || this.#stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (this.#hostActivity(session.id).busy || this.#hostActivity(session.id).leases || registered?.busy === true) {
      throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
    }
    const operation = (async () => {
      await this.#shutdown(session.id, host, 'worktree');
      if (!host.exited) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching worktrees');
      const { dir, pin } = await this.#prepare(session);
      const result = await this.#worktreeRpc(dir, pin, branch);
      const state = result.state;
      if (state.sessionId !== pin.sessionId || typeof state.sessionFile !== 'string') {
        throw new Error('Native OMP worktree returned an invalid session identity');
      }
      const sessionFile = await realpath(state.sessionFile);
      const header = await readHeader(sessionFile);
      const cwd = await realpath(header.cwd);
      if (header.id !== pin.sessionId || header.cwd !== cwd) throw new Error('Native OMP worktree history identity changed');
      await chmod(sessionFile, 0o600);
      await writeBinding(dir, { ...pin, cwd, sessionFile });
      session.runtime = { kind: 'managed', ...(cwd !== session.instancePath ? { worktreePath: cwd } : {}) };
      if (cwd === pin.cwd) throw new Error(result.text || 'OMP worktree command did not move the session');
      return result.text;
    })();
    this.#stopping.set(session.id, operation.then(() => undefined, () => undefined));
    try { return await operation; }
    finally { this.#stopping.delete(session.id); }
  }

  async #worktreeRpc(dir: string, pin: DurableBinding, branch?: string): Promise<{ text: string; state: Record<string, unknown> }> {
    const child = spawn(this.#config.omp.executable, [
      ...this.#config.omp.args, '--mode', 'rpc', '--resume', pin.sessionFile,
      '--cwd', pin.cwd, '--config', path.join(dir, 'runtime.yml'), '--no-title',
    ], { cwd: pin.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#skillProcesses.add(child);
    let buffer = '';
    let diagnostics = '';
    const outputs: string[] = [];
    let state: Record<string, unknown> | undefined;
    let failure: Error | undefined;
    const { promise: completion, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      failure = new Error('OMP worktree command timed out');
      child.kill('SIGKILL');
    }, this.#config.omp.startupTimeoutMs);
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
      this.#skillProcesses.delete(child);
    }
  }

  #sessionCwd(session: TopicSession): string {
    return session.runtime.kind === 'managed' ? session.runtime.worktreePath ?? session.instancePath : session.instancePath;
  }

  async #validatedSessionCwd(session: TopicSession): Promise<string> {
    if (await realpath(session.instancePath) !== session.instancePath) throw new Error('Instance path identity changed');
    const cwd = this.#sessionCwd(session);
    if (await realpath(cwd) !== cwd) throw new Error('Managed working directory identity changed');
    return cwd;
  }
  async validateSessionPaths(sessions: TopicSession[], config = this.#config): Promise<void> {
    for (const session of sessions) {
      const assigned = findInstance(config, session.botId, session.chatId);
      if (!assigned) continue;
      if (session.instancePath !== assigned.path) throw new Error(`Chat ${session.chatId} has history pinned to another instance path`);
      if (await realpath(session.instancePath) !== session.instancePath) throw new Error('Instance path identity changed');
      if (session.runtime.kind !== 'managed') continue;
      let cwd = this.#sessionCwd(session);
      const directory = path.resolve(config.dataDir, 'sessions', session.id);
      const history = path.join(directory, 'history.jsonl');
      let pin: DurableBinding | undefined;
      try {
        pin = JSON.parse(await readFile(path.join(directory, 'binding.json'), 'utf8')) as DurableBinding;
        if (pin.version !== 1 || typeof pin.cwd !== 'string' || !path.isAbsolute(pin.cwd) || typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) || typeof pin.sessionId !== 'string' || !pin.sessionId) {
          throw new Error(`Saved session ${session.id} conflicts with working directory ${cwd}`);
        }
      } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
      if (pin) cwd = pin.cwd;
      if (await realpath(cwd) !== cwd) throw new Error('Managed working directory identity changed');
      try {
        const header = await readHeader(pin?.sessionFile ?? history);
        if (header.cwd !== cwd || (pin && header.id !== pin.sessionId)) {
          throw new Error(`Saved history ${session.id} conflicts with working directory ${cwd}`);
        }
        if (pin) session.runtime = { kind: 'managed', ...(cwd !== session.instancePath ? { worktreePath: cwd } : {}) };
      } catch (error) {
        if (!errno(error, 'ENOENT') || pin) throw error;
      }
    }
  }
  #hostActivity(id: string): HostActivity {
    let activity = this.#activity.get(id);
    if (!activity) {
      activity = { busy: false, awaitingTurn: false, leases: 0, lastUsed: Date.now() };
      this.#activity.set(id,activity);
    }
    return activity;
  }
  retain(id: string): () => void {
    this.#assertActive();
    if (this.#managed.get(id)?.retiring || this.#stopping.has(id)) throw new Error('Session is retiring; rejoin after it settles');
    const activity = this.#hostActivity(id);
    activity.leases++;
    activity.lastUsed = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activity.leases--;
      activity.lastUsed = Date.now();
    };
  }
  markPrompt(id: string): void {
    this.#assertActive();
    if (this.#managed.get(id)?.retiring || this.#stopping.has(id)) throw new Error('Session is retiring; resend after it settles');
    const activity = this.#hostActivity(id);
    activity.busy = true;
    activity.awaitingTurn = true;
    activity.lastUsed = Date.now();
  }
  observeFrame(id: string, frame: HostFrame): void {
    const activity = this.#hostActivity(id);
    if (frame.t === 'event' && frame.event.type === 'agent_start') {
      activity.busy = true;
      activity.awaitingTurn = false;
    } else if ((frame.t === 'event' && (frame.event.type === 'agent_end' || miniAppInterruptionAuthor(frame.event))) || frame.t === 'error') {
      activity.busy = false;
      activity.awaitingTurn = false;
      activity.lastUsed = Date.now();
    } else if (frame.t === 'state' || frame.t === 'welcome') {
      activity.busy = activity.awaitingTurn || frame.state.isStreaming || frame.state.queuedMessageCount > 0;
      if (activity.busy) activity.lastUsed = Date.now();
    }
  }
  async retireIdle(idleMs = 300000): Promise<number> {
    let retired = 0;
    const candidates = [...this.#managed.entries()].sort(([a],[b]) => this.#hostActivity(a).lastUsed-this.#hostActivity(b).lastUsed);
    for (const [id,host] of candidates) {
      const activity = this.#hostActivity(id);
      if (!host || host.retiring || this.#pending.has(id) || activity.busy || activity.leases || Date.now()-activity.lastUsed < idleMs) continue;
      await this.#stop(id, 'idle');
      if (host.exited) retired++;
    }
    return retired;
  }
  async #discoverManaged(hosts: RegistryHost[]): Promise<void> {
    if (this.#discovered) return;
    const root = path.join(this.#config.dataDir,'sessions');
    let entries;
    try { entries = await readdir(root,{withFileTypes:true}); }
    catch (error) {
      if (errno(error,'ENOENT')) { this.#discovered = true; return; }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
      let pin: DurableBinding;
      try { pin = JSON.parse(await readFile(path.join(root,entry.name,'binding.json'),'utf8')) as DurableBinding; }
      catch (error) { if (errno(error,'ENOENT')) continue; throw error; }
      const host = hosts.find(value => value.sessionId === pin.sessionId && value.cwd === pin.cwd);
      if (!host) continue;
      const lifecycle = await this.#lifecycle(entry.name);
      this.#managed.set(entry.name,{sessionId:pin.sessionId,exited:false,retiring:lifecycle?.retiring===true});
      this.#hostActivity(entry.name).busy = host.busy !== false;
    }
    this.#discovered = true;
  }
  async #admitManaged(session: TopicSession): Promise<HostBinding> {
    const id = session.id;
    const previous = this.#admission;
    const {promise,resolve} = Promise.withResolvers<void>();
    this.#admission = promise;
    await previous;
    try {
      this.#assertActive();
      await this.#acquire();
      const hosts = await this.#list(Date.now()+this.#config.omp.startupTimeoutMs);
      await this.#discoverManaged(hosts);
      for (const [other,host] of this.#managed) {
        if (host && !this.#pending.has(other) && !hosts.some(value => value.sessionId === host.sessionId)) {
          if (host.retirement) {
            const identity = await procIdentity(host.retirement.pid);
            if (identity && identity.start === host.retirement.start && identity.state !== 'Z' && identity.state !== 'X') continue;
          }
          this.#managed.delete(other);
          this.#activity.delete(other);
        }
      }
      if (!this.#managed.has(id)) {
        if (this.#managed.size >= this.#sessionLimit) await this.retireIdle(0);
        if (this.#managed.size >= this.#sessionLimit) throw new SessionCapacityError(this.#sessionLimit);
        this.#managed.set(id,null);
      }
      this.#hostActivity(id).lastUsed = Date.now();
    } finally {
      resolve();
    }
    return this.#ensureManaged(session);
  }
  async isRunning(session: TopicSession): Promise<boolean> {
    this.#assertActive();
    if (this.#closed || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return false;
    if (this.#pending.has(session.id)) return true;
    if (session.runtime.kind === 'managed') await this.#acquire();
    const hosts = await this.#list(Date.now() + this.#config.omp.startupTimeoutMs);
    const runtime = session.runtime;
    if (runtime.kind === 'attached') return hosts.some(host => host.instanceId === runtime.instanceId && host.sessionId === runtime.sessionId && host.cwd === session.instancePath);
    let pin: DurableBinding;
    try {
      pin = JSON.parse(await readFile(path.join(this.#config.dataDir,'sessions',session.id,'binding.json'),'utf8')) as DurableBinding;
    } catch (error) {
      if (errno(error,'ENOENT')) return false;
      throw error;
    }
    return pin.cwd === this.#sessionCwd(session) && hosts.some(host => host.sessionId === pin.sessionId && host.cwd === pin.cwd);
  }

  ensure(session: TopicSession): Promise<HostBinding> {
    try { this.#assertActive(); } catch (error) { return Promise.reject(error); }
    if (this.#closed || this.#stopping.has(session.id)) return Promise.reject(new Error('OMP runtime is stopping'));
    if (!Object.hasOwn(this.#config.instances, session.instancePath)) return Promise.reject(new Error('Instance path is not configured'));
    const pending = this.#pending.get(session.id);
    if (pending) return pending;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return Promise.reject(new Error('Invalid managed session identifier'));
    const operation = session.runtime.kind === 'managed'
      ? this.#admitManaged(session)
      : this.attach(session.runtime.instanceId, session.instancePath).then(binding => {
        if (session.runtime.kind !== 'attached' || binding.sessionId !== session.runtime.sessionId) {
          throw new Error('Attached OMP session identity changed');
        }
        return binding;
      });
    const result = operation.finally(() => this.#pending.delete(session.id));
    this.#pending.set(session.id, result);
    return result;
  }

  async #nativeSetting(instancePath: string, key: string): Promise<unknown> {
    this.#assertActive();
    const args: string[] = [];
    const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
    for (const arg of ompArguments(this.#config.omp.args)) {
      if (arg.flag === '--alias') throw new Error('OMP --alias conflicts with native model preset settings discovery');
      if (arg.flag !== '--profile' && arg.flag !== '--config') continue;
      if (arg.value === undefined || !arg.value) throw new Error(`OMP ${arg.flag} requires a value for model preset settings discovery`);
      if (arg.flag === '--profile') args.push(...arg.args);
      else configFiles.push(arg.value);
    }
    args.push('config', 'get', key, '--json');
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile(this.#config.omp.executable, args, {
      cwd: instancePath,
      env: { ...process.env, ...(configFiles.length ? { PI_CONFIG_FILES: configFiles.join(path.delimiter) } : {}) },
      timeout: this.#config.omp.startupTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    const output = await promise;
    let result: unknown;
    try { result = JSON.parse(output); }
    catch { throw new Error(`OMP config get ${key} returned invalid JSON`); }
    if (!record(result) || result.key !== key || !Object.hasOwn(result, 'value')) {
      throw new Error(`OMP config get ${key} returned an invalid settings response`);
    }
    return result.value;
  }

  async availableModelPresets(instancePath: string): Promise<string[]> {
    const presets = await this.#nativeSetting(instancePath, 'modelPresets');
    if (!record(presets)) throw new Error('OMP config get modelPresets returned an invalid preset mapping');
    return Object.keys(presets).filter(name => presets[name] !== null && presets[name] !== undefined).sort((a, b) => a.localeCompare(b));
  }
  async listSkills(instancePath: string, session?: TopicSession, signal?: AbortSignal): Promise<Array<{ name: string; description: string }>> {
    signal?.throwIfAborted();
    this.#assertActive();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    if (!Object.hasOwn(this.#config.instances, instancePath)) throw new Error('Instance path is not configured');
    if (await realpath(instancePath) !== instancePath) throw new Error('Instance path identity changed');
    if (session && session.instancePath !== instancePath) throw new Error('Session does not belong to this instance path');
    let values: unknown;
    if (session?.runtime.kind === 'managed' && await this.isRunning(session)) {
      if (!(await this.#lifecycle(session.id))?.skills) {
        throw new Error('OMP host does not support skill discovery. Kill this managed host and send a new prompt to load the updated lifecycle extension.');
      }
      values = JSON.parse(await this.#hostControl(session, undefined, 'list_skills'));
    } else {
      values = await this.#cachedSkills(session ? await this.#validatedSessionCwd(session) : instancePath, signal);
    }
    if (!Array.isArray(values) || values.some(value => !record(value) || typeof value.name !== 'string' || !value.name || typeof value.description !== 'string')) {
      throw new Error('OMP returned an invalid skill catalog');
    }
    this.#assertActive();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    if (!Object.hasOwn(this.#config.instances, instancePath)) throw new Error('Instance path is not configured');
    return (values as Array<{ name: string; description: string }>)
      .map(value => ({ name: value.name, description: value.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #cachedSkills(instancePath: string, signal?: AbortSignal): Promise<Array<{ name: string; description: string }>> {
    signal?.throwIfAborted();
    this.#assertActive();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    const cached = this.#skillCatalogs.get(instancePath);
    if (cached && cached.expiresAt > Date.now()) {
      this.#skillCatalogs.delete(instancePath);
      this.#skillCatalogs.set(instancePath, cached);
      if (cached.catalog) return cached.catalog;
      throw cached.error;
    }
    let pending = this.#skillDiscovery.get(instancePath);
    if (pending?.controller.signal.aborted) {
      const abandoned = pending;
      await abandoned.promise.catch(error => {
        if (error !== abandoned.controller.signal.reason) throw error;
      });
      return this.#cachedSkills(instancePath, signal);
    }
    if (!pending) {
      const controller = new AbortController();
      const discovery = this.#discoverSkills(instancePath, controller.signal).then(catalog => {
        if (catalog.some(value => !value.name)) throw new Error('OMP returned an invalid skill catalog');
        this.#rememberSkills(instancePath, { catalog, expiresAt: Date.now() + 5 * 60_000 });
        return catalog;
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) this.#rememberSkills(instancePath, { error, expiresAt: Date.now() + 30_000 });
        throw error;
      }).finally(() => {
        this.#skillDiscovery.delete(instancePath);
      });
      pending = { promise: discovery, controller, consumers: 0 };
      this.#skillDiscovery.set(instancePath, pending);
    }
    pending.consumers++;
    try {
      return await (signal ? withCancellation(pending.promise, signal) : pending.promise);
    } finally {
      if (--pending.consumers === 0) {
        pending.controller.abort(signal?.reason ?? new Error('Skill discovery has no remaining consumers'));
        await pending.promise.catch(error => {
          if (error !== pending.controller.signal.reason) throw error;
        });
      }
    }
  }

  #rememberSkills(instancePath: string, entry: {
    expiresAt: number;
    catalog?: Array<{ name: string; description: string }>;
    error?: unknown;
  }): void {
    if (this.#closed) return;
    this.#skillCatalogs.delete(instancePath);
    this.#skillCatalogs.set(instancePath, entry);
    while (this.#skillCatalogs.size > 128) {
      this.#skillCatalogs.delete(this.#skillCatalogs.keys().next().value!);
    }
  }

  async #discoverSkills(instancePath: string, signal: AbortSignal): Promise<Array<{ name: string; description: string }>> {
    const args = ompArguments(this.#config.omp.args);
    for (const arg of args) {
      if (!arg.flag.startsWith('-') || ['--', '--alias', '--prewalk', '--prewalk-into', '--plan', '--plan-yolo', '--plan-yolo-into'].includes(arg.flag)) {
        throw new Error(`OMP argument ${arg.flag} conflicts with turn-free skill discovery`);
      }
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'omp-tg-skills-'));
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    try {
      const config = path.join(directory, 'discovery.yml');
      await privateFile(config, JSON.stringify({
        collab: { autoStart: 'off' },
        startup: { checkUpdate: false, setupWizard: false },
        skills: { enableSkillCommands: true },
      }));
      this.#assertActive();
      if (this.#closed) throw new Error('OMP runtime is stopping');
      signal.throwIfAborted();
      child = spawn(this.#config.omp.executable, [
        ...this.#config.omp.args, '--cwd', instancePath, '--config', config,
        '--mode', 'rpc', '--no-session', '--no-title',
      ], { cwd: instancePath, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      this.#skillProcesses.add(child);
      const processHandle = child;
      const closed = Promise.withResolvers<void>();
      processHandle.once('close', () => closed.resolve());
      exited = closed.promise;
      const requestId = randomUUID();
      const { promise, resolve, reject } = Promise.withResolvers<Array<{ name: string; description: string }>>();
        let input = '';
        let stderr = '';
        let bytes = 0;
        let settled = false;
        const finish = (error?: Error, commands?: Array<{ name: string; description: string }>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            if (stderr) error.message += `\n${stderr}`;
            reject(error);
          } else resolve(commands!);
        };
        const timer = setTimeout(() => finish(new Error('OMP skill discovery timed out')), this.#config.omp.startupTimeoutMs);
        processHandle.once('error', error => finish(error));
        processHandle.once('close', (code, signal) => finish(new Error(`OMP skill discovery exited before responding (code ${code}, signal ${signal})`)));
        processHandle.stderr!.setEncoding('utf8');
        processHandle.stderr!.on('data', (part: string) => {
          if (settled) return;
          stderr += part;
          if (Buffer.byteLength(stderr) > 2 * 1024 * 1024) finish(new Error('OMP skill discovery diagnostics are too large'));
        });
        processHandle.stdout!.setEncoding('utf8');
        processHandle.stdout!.on('data', (part: string) => {
          if (settled) return;
          bytes += Buffer.byteLength(part);
          if (bytes > 2 * 1024 * 1024) { finish(new Error('OMP skill discovery response is too large')); return; }
          input += part;
          let newline;
          while ((newline = input.indexOf('\n')) !== -1) {
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const response: unknown = JSON.parse(line);
              if (!record(response) || response.id !== requestId) continue;
              if (response.success !== true) throw new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response));
              if (!record(response.data) || !Array.isArray(response.data.commands)) throw new Error('Invalid OMP available commands response');
              const commands = response.data.commands.filter((command: unknown) => record(command) && command.source === 'skill');
              finish(undefined, commands.map((command: Record<string, unknown>) => {
                if (typeof command.name !== 'string' || !command.name.startsWith('skill:')) throw new Error('Invalid OMP skill command name');
                return { name: command.name.slice(6), description: typeof command.description === 'string' ? command.description : '' };
              }));
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          }
        });
        processHandle.stdin!.on('error', error => finish(error));
        processHandle.stdin!.write(`${JSON.stringify({ id: requestId, type: 'get_available_commands' })}\n`);
      return await withCancellation(promise, signal);
    } finally {
      if (child) {
        this.#killSkillProcess(child);
        await exited;
        this.#skillProcesses.delete(child);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }

  #killSkillProcess(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (!errno(error, 'ESRCH')) throw error;
    }
  }

  async #presetLaunch(session: TopicSession): Promise<{ overlay: Record<string, unknown>; args: string[]; preset?: string }> {
    const assigned = findInstance(this.#config, session.botId, session.chatId);
    if (assigned && assigned.path !== session.instancePath) throw new Error('Managed session forum assignment changed');
    const name = assigned?.instance.chats.find(chat => chat.botId === session.botId && chat.chatId === session.chatId)?.default_model_preset;
    if (name === undefined) return { overlay: {}, args: this.#config.omp.args };
    const presets = await this.#nativeSetting(this.#sessionCwd(session), 'modelPresets');
    if (!record(presets)) throw new Error('OMP config get modelPresets returned an invalid preset mapping');
    const preset = Object.hasOwn(presets, name) ? presets[name] : undefined;
    if (preset === undefined || preset === null) {
      const names = Object.keys(presets).filter(key => presets[key] !== null && presets[key] !== undefined).sort((a, b) => a.localeCompare(b));
      throw new Error(`Unknown model preset: ${name}. Available presets: ${names.join(', ') || '(none)'}`);
    }
    if (!record(preset) || !record(preset.modelRoles)) throw new Error(`Invalid model preset "${name}": modelRoles must be a mapping`);
    for (const [role, selector] of Object.entries(preset.modelRoles)) {
      if (typeof selector !== 'string' || !selector.trim()) throw new Error(`Invalid model preset "${name}": role "${role}" is not a model selector`);
    }
    const defaultThinking = await this.#nativeSetting(this.#sessionCwd(session), 'defaultThinkingLevel');
    const currentRoles = await this.#nativeSetting(this.#sessionCwd(session), 'modelRoles');
    if (!record(currentRoles)) throw new Error('OMP config get modelRoles returned an invalid role mapping');
    const modelRoles = Object.fromEntries([
      ...Object.keys(currentRoles).map(role => [role, null]),
      ...Object.entries(preset.modelRoles),
    ]);
    const args = ompArguments(this.#config.omp.args).filter(arg => !Object.hasOwn(PRESET_MODEL_ARGS, arg.flag)).flatMap(arg => arg.args);
    if (args.includes('--')) throw new Error('OMP -- conflicts with managed model preset launch arguments');
    return { overlay: { modelRoles, defaultThinkingLevel: defaultThinking }, args, preset: name };
  }

  async #presetReady(dir: string, pin: DurableBinding, pid?: number): Promise<boolean> {
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

  async #runningTitleBinding(session: TopicSession): Promise<HostBinding> {
    const pin = JSON.parse(await readFile(path.join(this.#config.dataDir, 'sessions', session.id, 'binding.json'), 'utf8')) as DurableBinding;
    const deadline = Date.now() + this.#config.omp.startupTimeoutMs;
    const hosts = (await this.#list(deadline)).filter(host => host.sessionId === pin.sessionId && host.cwd === this.#sessionCwd(session));
    if (hosts.length !== 1) throw new Error('OMP host stopped or changed during session title control');
    return this.#resolve(hosts[0]!, deadline);
  }

  async setSessionTitle(session: TopicSession, title: string): Promise<void> {
    this.#assertActive();
    if (!title.trim()) throw new Error('OMP session title cannot be empty');
    if (this.#closed || this.#stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (session.runtime.kind === 'attached') {
      throw new SessionTitleUnsupportedError('Session title control is unavailable for this attached OMP host. Rename it with /rename in its terminal; the native collab registry does not support renaming.');
    }
    if (!await this.isRunning(session)) return;
    await this.#hostControl(session, title, 'set_session_title');
  }

  async modelPresets(session: TopicSession, name?: string): Promise<string> {
    return this.#hostControl(session, name, 'model_presets');
  }

  async #hostControl(session: TopicSession, name: string | undefined, type: 'model_presets' | 'list_skills' | 'set_session_title'): Promise<string> {
    this.#assertActive();
    if (session.runtime.kind !== 'managed') {
      throw new Error('Model preset control is unavailable for attached OMP hosts. Use a managed topic session or run /modelpreset in the attached host.');
    }
    const release = this.retain(session.id);
    try {
      const binding = type === 'set_session_title'
        ? await this.#runningTitleBinding(session)
        : await this.ensure(session);
      const deadline = Date.now() + 15000;
      const lifecycle = await this.#lifecycle(session.id);
      if (type === 'set_session_title' && !lifecycle?.sessionTitles) {
        throw new Error('OMP host does not support session title control. Retire this managed host and rejoin to load the updated lifecycle extension.');
      }
      if (!lifecycle || lifecycle.modelPresets !== 2) {
        throw new Error('OMP host does not support model preset control. Retire this managed host and rejoin to load the updated lifecycle extension.');
      }
      const validate = async () => {
        this.#assertActive();
        if (this.#closed || this.#stopping.has(session.id)) throw new Error('OMP runtime is stopping');
        const current = (await this.#list(deadline)).find(host => host.instanceId === binding.instanceId);
        const descriptor = await this.#lifecycle(session.id);
        if (!current || current.sessionId !== binding.sessionId || current.generation !== binding.generation ||
            current.pid !== lifecycle.pid || current.cwd !== this.#sessionCwd(session) ||
            descriptor?.pid !== lifecycle.pid || descriptor.sessionId !== binding.sessionId ||
            descriptor.socketPath !== lifecycle.socketPath || descriptor.modelPresets !== 2) {
          throw new Error('OMP host identity changed during model preset control');
        }
        if (descriptor.retiring || this.#managed.get(session.id)?.retiring) throw new Error('Session is retiring; rejoin after it settles');
      };
      if (lifecycle.sessionId !== binding.sessionId ||
          path.dirname(lifecycle.socketPath) !== tmpdir() ||
          !/^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(lifecycle.socketPath))) {
        throw new Error('Invalid OMP model preset control descriptor');
      }
      for (const filename of [path.join(this.#config.dataDir, 'sessions', session.id, 'lifecycle.json'), lifecycle.socketPath]) {
        const stat = await lstat(filename);
        if (stat.isSymbolicLink() || (filename === lifecycle.socketPath ? !stat.isSocket() : !stat.isFile()) ||
            (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
          throw new Error('OMP model preset control must use private owner-only files');
        }
      }
      await validate();
      const requestId = randomUUID();
      const request = `${JSON.stringify({ type, requestId, sessionId: binding.sessionId, name, deadline })}\n`;
      if (Buffer.byteLength(request) > 16384) throw new Error('Model preset request is too large');
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const socket = createConnection(lifecycle.socketPath);
      let input = '';
      let size = 0;
      let settled = false;
      const done = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => done(new Error('OMP model preset control timed out; check the host before retrying a switch')), Math.max(1, deadline - Date.now()));
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        try {
          this.#assertActive();
          socket.write(request);
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once('error', error => done(error));
      socket.once('end', () => done(new Error('OMP model preset control closed without a response')));
      socket.once('close', () => done(new Error('OMP model preset control disconnected without a response')));
      socket.on('data', part => {
        size += Buffer.byteLength(part);
        if (size > 262144) { done(new Error('OMP model preset response is too large')); return; }
        input += part;
        if (!input.includes('\n')) return;
        try {
          const response = JSON.parse(input.trim()) as Record<string, unknown>;
          if (response.requestId !== requestId || response.sessionId !== binding.sessionId || response.pid !== lifecycle.pid) {
            throw new Error('OMP model preset response identity changed');
          }
          if (typeof response.error === 'string') { done(new Error(response.error)); return; }
          if (typeof response.text !== 'string') throw new Error('Invalid OMP model preset response');
          done(undefined, response.text);
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const text = await promise;
      await validate();
      return text;
    } finally {
      release();
    }
  }

  async attach(instanceId: string, instancePath: string): Promise<HostBinding> {
    this.#assertActive();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Invalid OMP instance identifier');
    await this.#acquire();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    const deadline = Date.now() + this.#config.omp.startupTimeoutMs;
    const host = (await this.#list(deadline)).find(candidate => candidate.instanceId === instanceId);
    if (!host) throw new Error('OMP host is not available');
    if (await realpath(instancePath) !== instancePath || await realpath(host.cwd) !== instancePath) throw new Error('Attached host does not belong to this instance path');
    const binding = await this.#resolve(host, deadline);
    if (this.#closed) throw new Error('OMP runtime is stopping');
    this.#assertActive();
    return binding;
  }

  stop(id: string): Promise<void> {
    return this.#stop(id);
  }

  #stop(id: string, guard?: 'idle' | 'worktree'): Promise<void> {
    const pending = this.#stopping.get(id);
    if (pending) return pending;
    const operation = (async () => {
      await this.#pending.get(id)?.catch(() => undefined);
      const host = this.#managed.get(id);
      if (host) await this.#shutdown(id,host,guard);
    })().finally(() => {
      if (this.#stopping.get(id) === operation) this.#stopping.delete(id);
    });
    this.#stopping.set(id, operation);
    return operation;
  }

  kill(session: TopicSession): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return Promise.reject(new Error('Invalid managed session identifier'));
    if (this.#closed) return Promise.reject(new Error('OMP runtime is stopping'));
    const pending = this.#killing.get(session.id);
    if (pending) return pending;
    const ids = new Set([session.id]);
    const sessionId = session.runtime.kind === 'attached' ? session.runtime.sessionId : this.#managed.get(session.id)?.sessionId;
    if (sessionId) {
      for (const [id, host] of this.#managed) {
        if (host?.sessionId === sessionId) ids.add(id);
      }
    }
    const operation = Promise.resolve().then(async () => {
      await Promise.allSettled([...ids].map(id => this.#pending.get(id)));
      await this.#acquire();
      await this.#killSession(session);
    }).finally(() => {
      for (const id of ids) {
        if (this.#killing.get(id) === operation) this.#killing.delete(id);
        if (this.#stopping.get(id) === operation) this.#stopping.delete(id);
      }
    });
    for (const id of ids) {
      this.#killing.set(id, operation);
      this.#stopping.set(id, operation);
    }
    return operation;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#idleTimer);
    this.#closing = (async () => {
      for (const child of this.#skillProcesses) this.#killSkillProcess(child);
      for (const discovery of this.#skillDiscovery.values()) discovery.controller.abort(new Error('OMP runtime is stopping'));
      await Promise.allSettled([...this.#skillDiscovery.values()].map(discovery => discovery.promise));
      this.#skillCatalogs.clear();
      await Promise.allSettled(this.#pending.values());
      await Promise.allSettled(this.#killing.values());
      await this.#acquiring?.catch(() => undefined);
      await this.retireIdle(0);
      this.#lock?.close();
      this.#lock = undefined;
    })();
    return this.#closing;
  }
  acquire(): Promise<void> { return this.#acquire(); }

  #acquire(): Promise<void> {
    if (this.#acquiring) return this.#acquiring;
    this.#acquiring = (async () => {
      if (this.#closed) throw new Error('OMP runtime is stopping');
      await mkdir(this.#config.dataDir, { recursive: true, mode: 0o700 });
      const file = path.resolve(this.#config.dataDir, 'runtime-lock.sqlite');
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(file);
        database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL); DELETE FROM owner;');
        database.prepare('INSERT INTO owner (pid) VALUES (?)').run(process.pid);
        await chmod(file, 0o600);
        await this.#revokeRetirementGrants();
        if (this.#closed) throw new Error('OMP runtime is stopping');
        this.#lock = database;
      } catch (error) {
        database?.close();
        throw new Error(`Cannot acquire exclusive OMP runtime ownership for dataDir: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    })();
    return this.#acquiring;
  }

  async #revokeRetirementGrants(): Promise<void> {
    const root = path.join(this.#config.dataDir, 'sessions');
    let entries;
    try {
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Managed session root is invalid');
      entries = await readdir(root, { withFileTypes: true });
    }
    catch (error) { if (errno(error, 'ENOENT')) return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())) continue;
      for (const filename of await readdir(directory)) {
        if (!RETIREMENT_GRANT.test(filename)) continue;
        const grant = path.join(directory, filename);
        try {
          const grantStat = await lstat(grant);
          if (!grantStat.isFile() || grantStat.isSymbolicLink() || (grantStat.mode & 0o077) !== 0 ||
              (process.getuid && grantStat.uid !== process.getuid())) continue;
          await unlink(grant);
        } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
      }
    }
  }

  async #prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }> {
    const dir = path.resolve(this.#config.dataDir, 'sessions', session.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed session directory is invalid');
    await chmod(dir, 0o700);
    const cwd = await this.#validatedSessionCwd(session);
    const sessionFile = path.join(dir, 'history.jsonl');
    let pin: DurableBinding | undefined;
    try {
      const metadata = path.join(dir, 'binding.json');
      if (!(await lstat(metadata)).isFile()) throw new Error('Invalid managed binding metadata');
      pin = JSON.parse(await readFile(metadata, 'utf8')) as DurableBinding;
      if (pin.version !== 1 || typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) || pin.cwd !== cwd || typeof pin.sessionId !== 'string' || !pin.sessionId) {
        throw new Error('Managed OMP binding is incompatible with this configuration');
      }
      await chmod(metadata, 0o600);
    } catch (error) {
      if (!errno(error, 'ENOENT')) throw error;
    }
    if (!pin) {
      let header: { id: string; cwd: string };
      try {
        header = await readHeader(sessionFile);
      } catch (error) {
        if (!errno(error, 'ENOENT')) throw error;
        if ((await readdir(dir)).some(file => file.endsWith('.jsonl'))) throw new Error('Unpinned managed histories require explicit recovery');
        const value = { type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
        await privateFile(sessionFile, `${JSON.stringify(value)}\n`, true);
        header = value;
      }
      if (header.cwd !== cwd) throw new Error('Managed history working directory changed');
      pin = { version: 1, sessionId: header.id, sessionFile, cwd };
      await writeBinding(dir, pin);
    }
    const header = await readHeader(pin.sessionFile);
    if (header.id !== pin.sessionId || header.cwd !== pin.cwd) throw new Error('Managed OMP history identity changed');
    await chmod(pin.sessionFile, 0o600);
    return { dir, pin };
  }

  async #ensureManaged(session: TopicSession): Promise<HostBinding> {
    const id = session.id;
    let owned = this.#managed.get(id);
    let spawned: ManagedHost | undefined;
    const deadline = Date.now() + this.#config.omp.startupTimeoutMs;
    let prepared: { dir: string; pin: DurableBinding };
    try { prepared = await this.#prepare(session); }
    catch (error) {
      if (!owned) this.#managed.delete(id);
      throw error;
    }
    try {
      await this.#acquire();
      const { dir, pin } = prepared;
      if (this.#closed || this.#stopping.has(id)) throw new Error('OMP runtime is stopping');
      this.#assertActive();
      let hosts = await this.#list(deadline);
      const matches = hosts.filter(host => host.sessionId === pin.sessionId);
      if (matches.length > 1) throw new Error('More than one host is serving the managed OMP session');
      if (matches.length === 1) {
        const host = matches[0]!;
        if (await realpath(host.cwd) !== pin.cwd) throw new Error('Managed host working directory changed');
        while (!await this.#presetReady(dir, pin, host.pid)) {
          if (Date.now() >= deadline) throw new Error('Managed OMP startup preset timed out');
          if (this.#closed || this.#stopping.has(id)) throw new Error('OMP runtime is stopping');
          this.#assertActive();
          await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        }
        const binding = await this.#resolve(host,deadline);
        const lifecycle = await this.#lifecycle(id);
        owned ??= { sessionId: pin.sessionId, exited: false, retiring: false };
        owned.binding = binding;
        const currentLifecycle = lifecycle?.pid === host.pid && lifecycle.sessionId === pin.sessionId;
        if (owned.retirement) {
          const identity = await procIdentity(owned.retirement.pid);
          if (!identity || identity.start !== owned.retirement.start || identity.state === 'Z' || identity.state === 'X' ||
              (currentLifecycle && (owned.retirement.pid !== host.pid || owned.retirement.socketPath !== lifecycle.socketPath))) {
            delete owned.retirement;
          }
        }
        if (owned.retirement?.error !== undefined) throw owned.retirement.error;
        owned.retiring = owned.retirement !== undefined || (currentLifecycle && lifecycle.retiring === true);
        this.#managed.set(id,owned);
        if (owned.retiring) throw new Error('Session is retiring; rejoin after it settles');
        this.#assertActive();
        return binding;
      }
      if (this.#closed || this.#stopping.has(id)) throw new Error('OMP runtime is stopping');
      if (owned?.retirement) {
        const identity = await procIdentity(owned.retirement.pid);
        if (identity && identity.start === owned.retirement.start && identity.state !== 'Z' && identity.state !== 'X') {
          if (owned.retirement.error !== undefined) throw owned.retirement.error;
          throw new Error('Session is retiring; rejoin after it settles');
        }
        delete owned.retirement;
        owned.retiring = false;
      }
      const launch = await this.#presetLaunch(session);
      const overlay = {
        collab: { autoStart: 'control', ...(this.#config.omp.relayUrl ? { relayUrl: this.#config.omp.relayUrl } : {}) },
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
      this.#assertActive();
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('./host-supervisor.mjs',import.meta.url)),
        this.#config.omp.executable,
        ...launch.args,
        '--cwd',pin.cwd,
        '--config',path.join(dir,'runtime.yml'),
        '--session-dir',dir,
        '--resume',pin.sessionFile,
        '--no-title',
        '--extension',fileURLToPath(new URL('./host-lifecycle.mjs',import.meta.url)),
      ], {
        cwd: pin.cwd,
        env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: dir, OMP_TELEGRAM_DEFAULT_PRESET: launch.preset ?? '' },
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      owned = { process: child, sessionId: pin.sessionId, exited: false, retiring: false };
      spawned = owned;
      this.#managed.set(id,owned);
      const record = owned;
      child.once('error',error => { record.failure = error.message; record.exited = true; });
      child.once('exit',() => {
        record.exited = true;
        if (this.#managed.get(id) === record) this.#managed.delete(id);
      });
      while (Date.now() < deadline) {
        if (this.#closed || this.#stopping.has(id)) throw new Error('OMP runtime is stopping');
        this.#assertActive();
        if (record.failure) throw new Error(record.failure);
        if (launch.preset !== undefined) await this.#presetReady(dir, pin);
        if (record.exited || !child.pid) throw new Error('Managed OMP process exited before its host was available');
        for (const host of hosts) {
          if (!await belongsTo(host.pid,child.pid)) continue;
          if (host.sessionId !== pin.sessionId || await realpath(host.cwd) !== pin.cwd) throw new Error('Managed OMP process switched its pinned session');
          if (!await this.#presetReady(dir, pin, host.pid)) continue;
          const binding = await this.#resolve(host,deadline);
          record.binding = binding;
          this.#assertActive();
          return binding;
        }
        await delay(Math.min(200,Math.max(1,deadline-Date.now())));
        hosts = await this.#list(deadline);
      }
      throw new Error('Managed OMP startup timed out');
    } catch (error) {
      if (spawned && !spawned.exited && !this.#killing.has(id)) {
        const cleanup = this.#shutdown(id, spawned);
        if (!this.#stopping.has(id)) this.#stopping.set(id, cleanup);
        try { await cleanup; }
        catch (cleanupError) {
          if (error instanceof Error) {
            Object.defineProperty(error, 'cleanupError', { value: cleanupError, configurable: true });
            error.message += `\nOMP startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          }
        }
        finally {
          if (this.#stopping.get(id) === cleanup) this.#stopping.delete(id);
        }
      }
      if ((!owned || owned.exited) && this.#managed.get(id) === owned) this.#managed.delete(id);
      if (spawned?.process && error instanceof Error) {
        error.message += `\nOMP terminal diagnostics (private; may contain session content): ${path.join(this.#config.dataDir, 'sessions', id, 'terminal.log')} (previous output: terminal.log.1)`;
      }
      throw error;
    }
  }

  async #json(args: string[], deadline: number): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('OMP discovery timed out');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(this.#config.omp.executable, args, {
        cwd: this.#config.dataDir,
        env: process.env,
        timeout: Math.min(remaining, 5_000),
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    try {
      const value: unknown = JSON.parse(output);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new Error('OMP discovery returned invalid JSON');
    }
  }

  async #list(deadline: number): Promise<RegistryHost[]> {
    const result = await this.#json(['collab', 'list', '--json'], deadline);
    if (result.version !== 1 || !Array.isArray(result.hosts)) throw new Error('Unsupported OMP Collab registry version');
    for (const host of result.hosts as RegistryHost[]) {
      if (!host || typeof host.instanceId !== 'string' || typeof host.sessionId !== 'string' || typeof host.cwd !== 'string' || !Number.isSafeInteger(host.pid) || host.pid < 1 || !Number.isSafeInteger(host.generation) || host.generation < 1 || (host.access !== 'view' && host.access !== 'control') || typeof host.relayConnected !== 'boolean') {
        throw new Error('Invalid OMP Collab registry host');
      }
    }
    return result.hosts as RegistryHost[];
  }

  async #resolve(host: RegistryHost, deadline: number): Promise<HostBinding> {
    this.#assertActive();
    if (host.access !== 'control' || !host.relayConnected) throw new Error('OMP host does not publish a connected control room');
    const link = await this.#json(['collab', 'link', host.instanceId, '--json'], deadline);
    if (link.version !== 1 || link.instanceId !== host.instanceId || link.generation !== host.generation || link.access !== 'control' || typeof link.url !== 'string') {
      throw new Error('OMP host changed while resolving its capability');
    }
    const parsed = parseCollabLink(link.url);
    if ('error' in parsed || !parsed.writeToken) throw new Error('OMP host returned an invalid control capability');
    const current = (await this.#list(deadline)).find(candidate => candidate.instanceId === host.instanceId);
    if (!current || current.sessionId !== host.sessionId || current.generation !== host.generation || current.pid !== host.pid) {
      throw new Error('OMP host session changed while resolving its capability');
    }
    return { instanceId: host.instanceId, sessionId: host.sessionId, generation: host.generation, url: link.url };
  }

  async #lifecycle(id: string): Promise<HostLifecycle | undefined> {
    await this.#acquire();
    try {
      const value = JSON.parse(await readFile(path.join(this.#config.dataDir,'sessions',id,'lifecycle.json'),'utf8')) as HostLifecycle;
      if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || typeof value.socketPath !== 'string' || typeof value.sessionId !== 'string') return undefined;
      return value;
    } catch (error) {
      if (errno(error,'ENOENT')) return undefined;
      throw error;
    }
  }
  async #executable(): Promise<string> {
    const executable = this.#config.omp.executable;
    if (executable.includes('/')) return realpath(path.resolve(executable));
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      try { return await realpath(path.resolve(directory || process.cwd(), executable)); }
      catch (error) { if (!errno(error, 'ENOENT') && !errno(error, 'ENOTDIR')) throw error; }
    }
    throw new Error('Cannot identify the configured OMP executable');
  }

  async #killProcess(pid: number, cwd: string, executable: string, validate: () => Promise<void>): Promise<void> {
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

  async #killSession(session: TopicSession): Promise<void> {
    const id = session.id;
    const owned = this.#managed.get(id);
    let pin: DurableBinding | undefined;
    if (session.runtime.kind === 'managed') {
      const dir = path.resolve(this.#config.dataDir, 'sessions', id);
      try {
        pin = JSON.parse(await readFile(path.join(dir, 'binding.json'), 'utf8')) as DurableBinding;
      } catch (error) {
        if (!errno(error, 'ENOENT')) throw error;
        if (owned) throw new Error('Managed OMP binding is missing');
        this.#activity.delete(id);
        return;
      }
      if (pin.version !== 1 || typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) || pin.cwd !== this.#sessionCwd(session)) {
        throw new Error('Managed OMP binding is incompatible with this configuration');
      }
      const header = await readHeader(pin.sessionFile);
      if (header.id !== pin.sessionId || header.cwd !== pin.cwd || (owned && owned.sessionId !== pin.sessionId)) {
        throw new Error('Managed OMP history identity changed');
      }
    }
    const target = session.runtime;
    const hosts = await this.#list(Date.now() + this.#config.omp.startupTimeoutMs);
    const matches = hosts.filter(host => target.kind === 'attached'
      ? host.instanceId === target.instanceId
      : host.sessionId === pin!.sessionId);
    if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
    const host = matches[0];
    const executable = host || owned?.process?.pid ? await this.#executable() : undefined;
    const lifecycle = pin ? await this.#lifecycle(id) : undefined;
    if (!host && lifecycle && !owned?.process) {
      const identity = await procIdentity(lifecycle.pid);
      if (identity && identity.state !== 'Z' && identity.state !== 'X') throw new Error('OMP host is not registered; cannot safely kill its process');
    }
    if (host) {
      if (target.kind === 'attached' && host.sessionId !== target.sessionId) throw new Error('Attached OMP session identity changed');
      const cwd = await realpath(host.cwd);
      if (cwd !== this.#sessionCwd(session)) throw new Error('OMP host does not belong to this session working directory');
      if (pin && cwd !== pin.cwd) throw new Error('Managed host working directory changed');
      if (owned?.binding && (owned.binding.instanceId !== host.instanceId || owned.binding.sessionId !== host.sessionId)) {
        throw new Error('Managed OMP host identity changed');
      }
      if (lifecycle && (lifecycle.sessionId !== host.sessionId || lifecycle.pid !== host.pid ||
          (owned?.process?.pid && lifecycle.supervisorPid !== owned.process.pid))) {
        throw new Error('Managed OMP lifecycle identity changed');
      }
      await this.#killProcess(host.pid, cwd, executable!, async () => {
        const current = (await this.#list(Date.now() + 5000)).find(value => value.instanceId === host.instanceId);
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
        await this.#killProcess(pid, pin.cwd, executable!, async () => {
          if (owned.exited || !await belongsTo(pid, supervisor)) throw new Error('Managed OMP startup process identity changed');
        });
      }
      if (!owned.exited && owned.process.exitCode === null && owned.process.signalCode === null) {
        try { owned.process.kill('SIGKILL'); }
        catch (error) { if (!errno(error, 'ESRCH')) throw error; }
      }
    }
    if (lifecycle) {
      const current = await this.#lifecycle(id);
      if (current?.pid === lifecycle.pid && current.sessionId === lifecycle.sessionId && current.socketPath === lifecycle.socketPath) {
        await unlink(path.join(this.#config.dataDir, 'sessions', id, 'lifecycle.json')).catch(error => {
          if (!errno(error, 'ENOENT')) throw error;
        });
        if (path.dirname(lifecycle.socketPath) === tmpdir() && /^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(lifecycle.socketPath))) {
          await unlink(lifecycle.socketPath).catch(error => { if (!errno(error, 'ENOENT')) throw error; });
        }
      }
    }
    if (owned) { owned.exited = true; owned.retiring = false; }
    if (host) {
      for (const [managedId, managed] of this.#managed) {
        if (!managed || managed.sessionId !== host.sessionId || (managed.binding && managed.binding.instanceId !== host.instanceId)) continue;
        managed.exited = true;
        managed.retiring = false;
        this.#managed.delete(managedId);
        this.#activity.delete(managedId);
      }
    }
    this.#managed.delete(id);
    this.#activity.delete(id);
  }

  async #shutdown(id: string, host: ManagedHost, guard?: 'idle' | 'worktree'): Promise<void> {
    if (host.exited) return;
    if (this.#killing.has(id)) return;
    const lifecycle = await this.#lifecycle(id);
    if (!lifecycle || lifecycle.sessionId !== host.sessionId) return;
    if (lifecycle.retirement !== 1 || (guard === 'worktree' && lifecycle.worktree !== true)) {
      if (guard === 'worktree') throw new Error('This running OMP host does not support idle-guarded worktree switching. Stop it when idle with /kill, then retry /worktree.');
      if (!guard) throw new Error('This running OMP host does not support safe retirement. Stop it with /kill, then send a new prompt to load the updated lifecycle extension.');
      return;
    }
    if (this.#killing.has(id)) return;
    if (host.process?.pid && lifecycle.supervisorPid !== host.process.pid) return;
    const current = (await this.#list(Date.now()+5000)).find(value => value.pid === lifecycle.pid && value.sessionId === host.sessionId);
    if (this.#killing.has(id)) return;
    if (!current) { host.exited = true; this.#managed.delete(id); return; }
    const identity = await procIdentity(lifecycle.pid);
    if (!identity || identity.state === 'Z' || identity.state === 'X') {
      host.exited = true;
      this.#managed.delete(id);
      return;
    }
    if (host.retirement && (host.retirement.pid !== lifecycle.pid || host.retirement.start !== identity.start ||
        host.retirement.socketPath !== lifecycle.socketPath)) {
      delete host.retirement;
      host.retiring = false;
    }
    if (host.retirement?.error !== undefined) throw host.retirement.error;
    const alreadyRetiring = host.retiring || lifecycle.retiring === true;
    const requestId = randomUUID();
    const grant = path.join(this.#config.dataDir, 'sessions', id, `retirement-${requestId}.request`);
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
    const timer = setTimeout(() => done('unknown'), Math.max(1, requestDeadline - Date.now()));
    socket.setEncoding('utf8');
    socket.once('error', () => done('unknown'));
    socket.once('connect', () => socket.write(request));
    let response = '';
    socket.on('data', data => {
      response += data;
      if (Buffer.byteLength(response) > 16384) { done('unknown'); return; }
      if (!response.includes('\n')) return;
      try {
        const result: unknown = JSON.parse(response.trim());
        if (!record(result) || result.requestId !== requestId || result.sessionId !== host.sessionId ||
            result.pid !== lifecycle.pid) { done('unknown'); return; }
        if (typeof result.error === 'string') { done('unknown', new Error(result.error)); return; }
        done(result.outcome === 'requested' || result.outcome === 'busy' || result.outcome === 'expired' ? result.outcome : 'unknown');
      } catch { done('unknown'); }
    });
    socket.once('end', () => done('unknown'));
    socket.once('close', () => done('unknown'));
    const result = await promise;
    if (result.outcome !== 'requested') {
      let cancelled = false;
      try {
        try { await unlink(grant); cancelled = true; }
        catch (error) { if (!errno(error, 'ENOENT')) throw error; }
        const observed = await this.#lifecycle(id);
        const sameHost = observed?.pid === lifecycle.pid && observed.supervisorPid === lifecycle.supervisorPid &&
          observed.sessionId === lifecycle.sessionId && observed.socketPath === lifecycle.socketPath;
        host.retiring = alreadyRetiring || (sameHost && observed.retiring === true) || !cancelled;
        if (!host.retiring) delete host.retirement;
      } catch (error) {
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
        host.exited = true;
        this.#managed.delete(id);
        this.#activity.delete(id);
        return;
      }
      await delay(100);
      if (this.#killing.has(id)) return;
    }
  }
}
