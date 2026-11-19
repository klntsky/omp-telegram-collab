import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import { requestLifecycle } from './lifecycle-client.js';
import { privateFile, readHeader, writeBinding } from './files.js';
import { activeLaunchDir, launchProcess, readLaunch } from './launch-record.js';
import { ConversationConflictError, ConversationTransitionPendingError, type DurableBinding, type HostLifecycle, type ManagedHost, type RegistryHost } from './types.js';
import { errno, record } from './values.js';

interface ConversationStatus {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  candidate?: { sessionId: string; sessionFile: string; cwd: string; sequence: number; reason: string; previousSessionFiles: string[] };
}

async function conversationStatus(host: HostLifecycle, acknowledgedSessionFile: string): Promise<ConversationStatus> {
  const value = await requestLifecycle(host, { type: 'status', requestId: randomUUID(), acknowledgedSessionFile, deadline: Date.now() + 2000 });
  if (typeof value.error === 'string') throw new Error(value.error);
  if (typeof value.sessionId !== 'string' || typeof value.sessionFile !== 'string' || typeof value.cwd !== 'string') throw new Error('Invalid OMP conversation status');
  if (value.candidate !== undefined) {
    const candidate = value.candidate;
    if (!record(candidate) || typeof candidate.sessionId !== 'string' || typeof candidate.sessionFile !== 'string' ||
        typeof candidate.cwd !== 'string' || !Number.isSafeInteger(candidate.sequence) || typeof candidate.reason !== 'string' ||
        !Array.isArray(candidate.previousSessionFiles) || !candidate.previousSessionFiles.every(file => typeof file === 'string')) throw new Error('Invalid OMP conversation transition');
  }
  return value as unknown as ConversationStatus;
}
type ConversationTarget = Pick<TopicSession, 'id' | 'cwd' | 'runtime'>;

interface ConversationDependencies {
  config: AppConfig;
  managed: Map<string, ManagedHost | null>;
  acquire(): Promise<void>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  list(deadline: number): Promise<RegistryHost[]>;
  assertActive(): void;
  beforeChange?(id: string): void;
}

export interface RuntimeConversation {
  refresh(session: ConversationTarget): Promise<void>;
}

export function createConversation(deps: ConversationDependencies): RuntimeConversation {
  const pending = new Map<string, Promise<void>>();
  function refresh(session: ConversationTarget): Promise<void> {
    if (session.runtime.kind !== 'managed') return Promise.resolve();
    const existing = pending.get(session.id);
    if (existing) return existing.then(() => synchronizeCwd(session));
    const operation = synchronize(session).finally(() => pending.delete(session.id));
    pending.set(session.id, operation);
    return operation;
  }

  async function binding(session: ConversationTarget): Promise<DurableBinding | undefined> {
    try { return JSON.parse(await readFile(path.join(deps.config.dataDir, 'sessions', session.id, 'binding.json'), 'utf8')) as DurableBinding; }
    catch (error) { if (errno(error, 'ENOENT')) return undefined; throw error; }
  }

  async function synchronizeCwd(session: ConversationTarget): Promise<void> {
    const pin = await binding(session);
    if (pin) session.cwd = pin.cwd;
  }

  async function synchronize(session: ConversationTarget): Promise<void> {
    deps.assertActive();
    const pin = await binding(session);
    if (!pin || pin.removedWorktree) return;
    const root = path.join(deps.config.dataDir, 'sessions', session.id);
    const launch = await readLaunch(root);
    if (!launch || launch.resolved) return;
    await deps.acquire();
    const lifecycle = await deps.lifecycle(session.id);
    if (lifecycle?.conversations !== 1) return;
    const launchDir = await activeLaunchDir(root);
    try {
      const failure = await readFile(path.join(launchDir, 'conversation-conflict.txt'), 'utf8');
      throw new ConversationConflictError(failure);
    } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
    const owner = launch.host;
    if (!owner) return;
    const identity = await launchProcess(root, owner.pid);
    if (!identity) return;
    if (lifecycle.pid !== owner.pid) throw new ConversationConflictError('Managed OMP lifecycle host identity changed');
    const status = await conversationStatus(lifecycle, pin.sessionFile);
    if (status.sessionId === pin.sessionId && status.sessionFile === pin.sessionFile && status.cwd === pin.cwd) {
      return;
    }
    const conflict = async (message: string): Promise<never> => {
      const error = new ConversationConflictError(message);
      try { await privateFile(path.join(launchDir, 'conversation-conflict.txt'), message); }
      catch (failure) { throw new AggregateError([error, failure], `${message}\n${failure instanceof Error ? failure.message : String(failure)}`); }
      throw error;
    };
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const hosts = await deps.list(deadline);
    const host = hosts.find(value => value.pid === owner.pid && value.instanceId === owner.instanceId);
    // Collab withholds snapshots during rollback-capable transitions and only
    // publishes a successor after settlement. Hooks alone are not commit proof.
    // https://github.com/can1357/oh-my-pi/blob/v19.0.0/packages/coding-agent/src/collab/controller.ts#L231-L275
    if (!host || host.sessionId !== status.sessionId || host.cwd !== status.cwd) throw new ConversationTransitionPendingError('OMP conversation transition is not yet published');
    const candidate = status.candidate;
    if (!candidate || candidate.sessionId !== status.sessionId || candidate.sessionFile !== status.sessionFile || candidate.cwd !== status.cwd ||
        !candidate.previousSessionFiles.includes(pin.sessionFile) || !['new', 'resume', 'fork', 'branch', 'btw'].includes(candidate.reason)) {
      return conflict('Managed OMP conversation changed without an intentional native transition; history is preserved and automatic delivery is blocked');
    }
    if (hosts.some(value => value.sessionId === status.sessionId && value.pid !== owner.pid)) {
      return conflict('Another OMP host is already serving the selected conversation');
    }
    const file = await realpath(status.sessionFile);
    const cwd = await realpath(status.cwd);
    const header = await readHeader(file);
    if (header.id !== status.sessionId || header.cwd !== cwd || file !== status.sessionFile || cwd !== status.cwd) {
      return conflict('Managed OMP transition history identity changed');
    }
    const confirmed = await conversationStatus(lifecycle, pin.sessionFile);
    const currentIdentity = await launchProcess(root, owner.pid);
    if (confirmed.sessionId !== status.sessionId || confirmed.sessionFile !== file || confirmed.cwd !== cwd ||
        confirmed.candidate?.sequence !== candidate.sequence || currentIdentity?.start !== owner.start) throw new ConversationTransitionPendingError('OMP conversation changed during synchronization');
    deps.assertActive();
    const current = await binding(session);
    if (current?.sessionId !== pin.sessionId || current.sessionFile !== pin.sessionFile || current.cwd !== pin.cwd) throw new Error('Managed OMP binding changed during synchronization');
    deps.beforeChange?.(session.id);
    await writeBinding(root, { version: 1, sessionId: status.sessionId, sessionFile: file, cwd });
    session.cwd = cwd;
    const managed = deps.managed.get(session.id);
    if (managed) {
      managed.sessionId = status.sessionId;
      managed.cwd = cwd;
      delete managed.binding;
    }
  }

  return { refresh };
}
