import { createActivity, type RuntimeActivity } from './runtime/activity.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, HostBinding, TopicSession } from '../shared/contracts.js';
import { refreshTermination } from './config.js';
import { HistoryWatch } from './history-watch.js';
import { connectCollab, readCollabState } from './collab.js';
import type { Omp } from './omp.js';
import { type ForkTarget, type ManagedHost } from './runtime/types.js';
import { FORBIDDEN_ARGS } from './runtime/arguments.js';
import { record } from './runtime/values.js';
import { createFork, type RuntimeFork } from './runtime/fork.js';
import { createForkRpc, type RuntimeForkRpc } from './runtime/fork-rpc.js';
import { createWorktree, type RuntimeWorktree } from './runtime/worktree.js';
import { createPaths, type RuntimePaths } from './runtime/paths.js';
import { createRegistry, type RuntimeRegistry } from './runtime/registry.js';
import { createSettings, type RuntimeSettings } from './runtime/settings.js';
import { createSkills, type RuntimeSkills } from './runtime/skills.js';
import { createHostControl, type RuntimeHostControl } from './runtime/host-control.js';
import { createStartup, type RuntimeStartup } from './runtime/startup.js';
import { createProcessKill, type RuntimeProcessKill } from './runtime/process-kill.js';
import { createRetirement, type RuntimeRetirement } from './runtime/retirement.js';
import { createOwnership, type RuntimeOwnership } from './runtime/ownership.js';
import { createAdmission, type RuntimeAdmission } from './runtime/admission.js';
import { createSessions, type RuntimeSessions } from './runtime/sessions.js';
import { createTermination, type RuntimeTermination } from './runtime/termination.js';

// Terminal joins launch only the native client; they must not acquire service-owned runtime resources.
export const terminalOmp: Pick<Omp, 'joinTerminal'> = {
  joinTerminal(executable, url) {
    return spawn(executable, ['join', url], { stdio: 'inherit', shell: false });
  },
};

// The facade owns the native-host ledger: admission, leases and operation fencing
// must observe the same identities. Domain owners receive only their required capabilities.
export class OmpRuntime implements Omp {
  readonly #activity: RuntimeActivity;
  observeFrame: (id: string, frame: HostFrame) => void;
  markPrompt: (id: string) => void;
  retain: (id: string) => () => void;
  readonly #fork: RuntimeFork;
  readonly #forkRpc: RuntimeForkRpc;
  readonly #worktree: RuntimeWorktree;
  readonly #paths: RuntimePaths;
  readonly #registry: RuntimeRegistry;
  readonly #settings: RuntimeSettings;
  readonly #skills: RuntimeSkills;
  readonly #hostControl: RuntimeHostControl;
  readonly #startup: RuntimeStartup;
  readonly #processKill: RuntimeProcessKill;
  readonly #retirement: RuntimeRetirement;
  readonly #ownership: RuntimeOwnership;
  readonly #admission: RuntimeAdmission;
  readonly #sessions: RuntimeSessions;
  readonly #termination: RuntimeTermination;
  readonly connectCollab: Omp['connectCollab'] = connectCollab;
  readonly readCollabState: Omp['readCollabState'] = readCollabState;
  readonly watchHistory: Omp['watchHistory'] = HistoryWatch.open;
  readonly joinTerminal: Omp['joinTerminal'] = terminalOmp.joinTerminal;
  readonly #config: AppConfig;
  readonly #pending = new Map<string, Promise<HostBinding>>();
  readonly #managed = new Map<string, ManagedHost | null>();
  readonly #reservations = new Map<symbol, string>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #killing = new Map<string, Promise<void>>();
  readonly #skillProcesses = new Set<ChildProcess>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #idleTimer: NodeJS.Timeout;
  #sessionLimit: number;
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
    const runtime = this;
    this.#activity = createActivity({
      assertActive: () => this.#assertActive(),
      managed: this.#managed,
      stopping: this.#stopping,
    });
    this.#fork = createFork({
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      config: this.#config,
      hostActivity: (id) => runtime.#activity.hostActivity(id),
      pending: this.#pending,
      stopping: this.#stopping,
      reservations: this.#reservations,
      acquire: () => runtime.#ownership.acquire(),
      readManagedBinding: (session) => runtime.#paths.readManagedBinding(session),
      managed: this.#managed,
      validatedSessionCwd: (session) => runtime.#paths.validatedSessionCwd(session),
      list: (deadline) => runtime.#registry.list(deadline),
      forkRpc: (sessionFile, cwd, config, command) => runtime.#forkRpc.forkRpc(sessionFile, cwd, config, command),
    });
    this.#forkRpc = createForkRpc({
      get closed() { return runtime.#closed; },
      config: this.#config,
      skillProcesses: this.#skillProcesses,
      killSkillProcess: (child) => runtime.#skills.killSkillProcess(child),
    });
    this.#worktree = createWorktree({
      config: this.#config,
      reserveSession: (sessionId, beforeMutation) => runtime.reserveSession(sessionId, beforeMutation),
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      stopping: this.#stopping,
      hostActivity: (id) => runtime.#activity.hostActivity(id),
      pending: this.#pending,
      ensure: (session, beforeMutation) => runtime.ensure(session, beforeMutation),
      managed: this.#managed,
      list: (deadline) => runtime.#registry.list(deadline),
      shutdown: (id, host, guard) => runtime.#retirement.shutdown(id, host, guard),
      prepare: (session) => runtime.#paths.prepare(session),
      validateCwd: (cwd) => runtime.#paths.validateCwd(cwd),
      skillProcesses: this.#skillProcesses,
    });
    this.#paths = createPaths({
      config: this.#config,
      managed: this.#managed,
    });
    this.#registry = createRegistry({
      config: this.#config,
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      acquire: () => runtime.#ownership.acquire(),
    });
    this.#settings = createSettings({
      assertActive: () => runtime.#assertActive(),
      config: this.#config,
      instanceDirectory: (instanceId) => runtime.#instanceDirectory(instanceId),
    });
    this.#skills = createSkills({
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      config: this.#config,
      skillProcesses: this.#skillProcesses,
    });
    this.#hostControl = createHostControl({
      config: this.#config,
      list: (deadline) => runtime.#registry.list(deadline),
      resolve: (host, deadline) => runtime.#registry.resolve(host, deadline),
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      stopping: this.#stopping,
      isRunning: (session) => runtime.isRunning(session),
      retain: (id) => runtime.retain(id),
      ensure: (session, beforeMutation) => runtime.ensure(session, beforeMutation),
      lifecycle: (id) => runtime.#ownership.lifecycle(id),
      managed: this.#managed,
    });
    this.#startup = createStartup({
      managed: this.#managed,
      config: this.#config,
      prepare: (session) => runtime.#paths.prepare(session),
      acquire: () => runtime.#ownership.acquire(),
      get closed() { return runtime.#closed; },
      stopping: this.#stopping,
      assertActive: () => runtime.#assertActive(),
      list: (deadline) => runtime.#registry.list(deadline),
      resolve: (host, deadline) => runtime.#registry.resolve(host, deadline),
      lifecycle: (id) => runtime.#ownership.lifecycle(id),
      presetLaunch: (session) => runtime.#settings.presetLaunch(session),
      killing: this.#killing,
      shutdown: (id, host, guard) => runtime.#retirement.shutdown(id, host, guard),
    });
    this.#processKill = createProcessKill({
      config: this.#config,
      managed: this.#managed,
      forgetActivity: id => runtime.#activity.forget(id),
      list: (deadline) => runtime.#registry.list(deadline),
      lifecycle: (id) => runtime.#ownership.lifecycle(id),
    });
    this.#retirement = createRetirement({
      managed: this.#managed,
      forgetActivity: id => runtime.#activity.forget(id),
      killing: this.#killing,
      lifecycle: (id) => runtime.#ownership.lifecycle(id),
      list: (deadline) => runtime.#registry.list(deadline),
      config: this.#config,
    });
    this.#ownership = createOwnership({
      get closed() { return runtime.#closed; },
      config: this.#config,
    });
    this.#admission = createAdmission({
      config: this.#config,
      lifecycle: (id) => runtime.#ownership.lifecycle(id),
      managed: this.#managed,
      hostActivity: (id) => runtime.#activity.hostActivity(id),
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      acquire: () => runtime.#ownership.acquire(),
      list: (deadline) => runtime.#registry.list(deadline),
      pending: this.#pending,
      forgetActivity: id => runtime.#activity.forget(id),
      reservations: this.#reservations,
      capacityUsed: () => runtime.#capacityUsed(),
      get sessionLimit() { return runtime.#sessionLimit; },
      retireIdle: (idleMs) => runtime.retireIdle(idleMs),
    });
    this.#sessions = createSessions({
      assertActive: () => runtime.#assertActive(),
      get closed() { return runtime.#closed; },
      pending: this.#pending,
      acquire: () => runtime.#ownership.acquire(),
      list: (deadline) => runtime.#registry.list(deadline),
      config: this.#config,
      stopping: this.#stopping,
      readManagedBinding: (session) => runtime.#paths.readManagedBinding(session),
      resolve: (host, deadline) => runtime.#registry.resolve(host, deadline),
      managed: this.#managed,
      hostActivity: (id) => runtime.#activity.hostActivity(id),
    });
    this.#termination = createTermination({
      config: this.#config,
      managed: this.#managed,
      stopping: this.#stopping,
      pending: this.#pending,
      readManagedBinding: (session) => runtime.#paths.readManagedBinding(session),
      shutdown: (id, host, guard) => runtime.#retirement.shutdown(id, host, guard),
      get closed() { return runtime.#closed; },
      killing: this.#killing,
      acquire: () => runtime.#ownership.acquire(),
      killSession: (session) => runtime.#processKill.killSession(session),
    });
    this.fork = this.#fork.fork;
    this.worktree = this.#worktree.worktree;
    this.topicTitleStatus = this.#worktree.topicTitleStatus;
    this.validateSessionPaths = this.#paths.validateSessionPaths;
    this.attach = this.#registry.attach;
    this.providerUsage = this.#settings.providerUsage;
    this.availableModelPresets = this.#settings.availableModelPresets;
    this.modelPresetDetails = this.#settings.modelPresetDetails;
    this.setSessionTitle = this.#hostControl.setSessionTitle;
    this.modelPresets = this.#hostControl.modelPresets;
    this.isRunning = this.#sessions.isRunning;
    this.resolveExisting = this.#sessions.resolveExisting;
    this.historySource = this.#sessions.historySource;
    this.existingBinding = this.#sessions.existingBinding;
    this.stop = this.#termination.stop;
    this.kill = this.#termination.kill;
    this.retain = this.#activity.retain;
    this.markPrompt = this.#activity.markPrompt;
    this.observeFrame = this.#activity.observeFrame;
    this.#idleTimer = setInterval(() => {
      void this.retireIdle().catch(error => console.error('OMP idle retirement failed:', error));
    }, 60000);
    this.#idleTimer.unref();
  }
  #assertActive(): void {
    if (refreshTermination(this.#config)) {
      this.#reservations.clear();
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
  async reserveSession(sessionId?: string, beforeMutation?: () => Promise<void>): Promise<{ bind(id: string): void; release(): void }> {
    const originalId = sessionId ?? randomUUID();
    const token = Symbol();
    await this.#admission.claimManaged(originalId, beforeMutation, token);
    return {
      bind: id => {
        this.#assertActive();
        if (this.#closed || !this.#reservations.has(token)) throw new Error('OMP reservation expired');
        if (sessionId !== undefined && id !== sessionId) throw new Error('OMP reservation target cannot change');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid managed session identifier');
        this.#reservations.set(token, id);
        sessionId = id;
      },
      release: () => { this.#reservations.delete(token); },
    };
  }
  #capacityUsed(): number {
    return new Set([...this.#managed.keys(), ...this.#reservations.values()]).size;
  }
  topicTitleStatus: (session: TopicSession) => Promise<{ worktree: boolean; branch?: string }>;
  fork: (source: TopicSession, destination: TopicSession, target?: ForkTarget, beforeMutation?: () => Promise<void>) => Promise<void>;
  existingBinding: (session: TopicSession) => Promise<{sessionId: string} | undefined>;
  worktree: (session: TopicSession, branch?: string, beforeMutation?: () => Promise<void>) => Promise<string>;
  #instanceDirectory(instanceId: number): string {
    const instance = this.#config.instances.find(instance => instance.id === instanceId);
    if (!instance) throw new Error('Instance ID is not configured');
    return instance.defaultDir;
  }
  validateSessionPaths: (sessions: TopicSession[], config?: AppConfig) => Promise<void>;
  async retireIdle(idleMs = 300000): Promise<number> {
    let retired = 0;
    const candidates = [...this.#managed.entries()].sort(([a],[b]) => this.#activity.hostActivity(a).lastUsed-this.#activity.hostActivity(b).lastUsed);
    for (const [id,host] of candidates) {
      const activity = this.#activity.hostActivity(id);
      if (!host || this.#pending.has(id) || [...this.#reservations.values()].includes(id) || (!host.retiring && (activity.busy || activity.leases || Date.now()-activity.lastUsed < idleMs))) continue;
      await this.#termination.stopHost(id, 'idle');
      if (host.exited) retired++;
    }
    return retired;
  }
  async #admitManaged(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding> {
    await this.#admission.claimManaged(session.id, beforeMutation);
    return this.#startup.ensureManaged(session,beforeMutation);
  }
  isRunning: (session: TopicSession) => Promise<boolean>;
  historySource: (session: TopicSession) => Promise<{ sessionId: string; path: string } | undefined>;
  resolveExisting: (session: TopicSession) => Promise<HostBinding | undefined>;
  ensure(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding> {
    if (session.status !== 'open') return Promise.reject(new Error('Session closed'));
    try { this.#assertActive(); } catch (error) { return Promise.reject(error); }
    if (this.#closed || this.#stopping.has(session.id)) return Promise.reject(new Error('OMP runtime is stopping'));
    if (!this.#config.instances.some(instance => instance.id === session.instanceId)) return Promise.reject(new Error('Instance path is not configured'));
    const pending = this.#pending.get(session.id);
    if (pending) return pending;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return Promise.reject(new Error('Invalid managed session identifier'));
    const operation = session.runtime.kind === 'managed'
      ? this.#admitManaged(session,beforeMutation)
      : this.#registry.attach(session.runtime.instanceId, session.cwd).then(binding => {
        if (session.runtime.kind !== 'attached' || binding.sessionId !== session.runtime.sessionId) {
          throw new Error('Attached OMP session identity changed');
        }
        return binding;
      });
    const result = operation.finally(() => this.#pending.delete(session.id));
    this.#pending.set(session.id, result);
    return result;
  }
  providerUsage: (instanceId: number) => Promise<{ heading: string; table: string }[]>;
  availableModelPresets: (instanceId: number, discoveryCwd?: string) => Promise<string[]>;
  modelPresetDetails: (instanceId: number, name: string, discoveryCwd?: string) => Promise<{modelRoles: Record<string, string>; defaultThinkingLevel?: string}>;
  async listSkills(instanceId: number, session?: TopicSession, signal?: AbortSignal, discoveryCwd?: string): Promise<Array<{ name: string; description: string }>> {
    signal?.throwIfAborted();
    this.#assertActive();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    const instancePath = this.#instanceDirectory(instanceId);
    if (session && session.instanceId !== instanceId) throw new Error('Session does not belong to this instance ID');
    let values: unknown;
    // Preserve the public activity port's dispatch, including operation instrumentation.
    if (session?.runtime.kind === 'managed' && await this.isRunning(session)) {
      if (!(await this.#ownership.lifecycle(session.id))?.skills) {
        throw new Error('OMP host does not support skill discovery. Kill this managed host and send a new prompt to load the updated lifecycle extension.');
      }
      values = JSON.parse(await this.#hostControl.hostControl(session, undefined, 'list_skills'));
    } else {
      const cwd = session ? await this.#paths.validatedSessionCwd(session) : discoveryCwd ?? instancePath;
      if (!session && discoveryCwd !== undefined) await this.#paths.validateCwd(cwd);
      values = await this.#skills.cachedSkills(cwd, signal);
    }
    if (!Array.isArray(values) || values.some(value => !record(value) || typeof value.name !== 'string' || !value.name || typeof value.description !== 'string')) {
      throw new Error('OMP returned an invalid skill catalog');
    }
    this.#assertActive();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    this.#instanceDirectory(instanceId);
    return (values as Array<{ name: string; description: string }>)
      .map(value => ({ name: value.name, description: value.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  setSessionTitle: (session: TopicSession, title: string) => Promise<void>;
  modelPresets: (session: TopicSession, name?: string) => Promise<string>;
  attach: (instanceId: string, instancePath: string) => Promise<HostBinding>;
  stop: (session: TopicSession) => Promise<boolean>;
  kill: (session: TopicSession) => Promise<void>;
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#reservations.clear();
    clearInterval(this.#idleTimer);
    this.#closing = (async () => {
      for (const child of this.#skillProcesses) this.#skills.killSkillProcess(child);
      await this.#skills.closeDiscovery();
      await Promise.allSettled(this.#pending.values());
      await this.#fork.drain();
      await Promise.allSettled(this.#killing.values());
      await this.#ownership.settleAcquisition();
      await this.retireIdle(0);
      this.#ownership.close();
    })();
    return this.#closing;
  }
  acquire(): Promise<void> { return this.#ownership.acquire(); }
}
