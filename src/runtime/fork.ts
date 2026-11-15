import { parseObject, OmpProtocolError, settleOperations, systemError, OmpSessionUnavailableError, OmpConfigurationError, OmpIdentityError, OmpHostBusyError, OmpRuntimeStoppingError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { type ForkTarget, type RegistryHost, type DurableBinding, type ManagedHost, type HostActivity } from './types.js';
import { privateFile, writeBinding, readHeader } from './files.js';
import { record, errno } from './values.js';
interface ForkDependencies {
  assertActive(): void;
  readonly closed: boolean;
  readonly config: AppConfig;
  hostActivity(id: string): HostActivity;
  readonly pending: Map<string, Promise<HostBinding>>;
  readonly stopping: Map<string, Promise<void>>;
  readonly reservations: Map<symbol, string>;
  acquire(): Promise<void>;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  readonly managed: Map<string, ManagedHost | null>;
  validatedSessionCwd(session: TopicSession): Promise<string>;
  list(deadline: number): Promise<RegistryHost[]>;
  forkRpc(sessionFile: string, cwd: string, config: string, command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// This owner keeps the complete fork transaction and its cleanup together.
export interface RuntimeFork {
  fork(source: TopicSession, destination: TopicSession, target?: ForkTarget, beforeMutation?: () => Promise<void>): Promise<void>;
  drain(): Promise<void>;
}

export function createFork(deps: ForkDependencies): RuntimeFork {
  const forks = new Set<Promise<void>>();
  async function fork(source: TopicSession, destination: TopicSession, target?: ForkTarget, beforeMutation?: () => Promise<void>): Promise<void> {
    const assertSessions = () => {
      deps.assertActive();
      if (deps.closed) throw new OmpRuntimeStoppingError(`Fork session ${source.id} to ${destination.id}`);
      for (const session of [source, destination]) {
        if (session.status !== 'open') throw new OmpSessionUnavailableError('Session closed', `Fork session ${source.id} to ${destination.id}`);
        if (session.runtime.kind !== 'managed') throw new OmpSessionUnavailableError('Attached OMP sessions cannot be forked', `Fork session ${source.id} to ${destination.id}`);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new OmpConfigurationError('Invalid managed session identifier', `Fork session ${source.id} to ${destination.id}`);
      }
      if (source.id === destination.id) throw new OmpSessionUnavailableError('Fork destination must be independent', `Fork session ${source.id} to ${destination.id}`);
      if (source.instanceId !== destination.instanceId || !deps.config.instances.some(instance => instance.id === source.instanceId)) {
        throw new OmpIdentityError('Fork sessions must belong to the same configured instance', `Fork session ${source.id} to ${destination.id}`);
      }
      const activity = deps.hostActivity(source.id);
      if (activity.busy || deps.pending.has(source.id)) throw new OmpHostBusyError('OMP host is busy; wait for the current turn and queued messages to finish before forking', `Fork session ${source.id} to ${destination.id}`);
    };
    assertSessions();
    if ([source, destination].some(session => deps.stopping.has(session.id) || deps.pending.has(session.id))) throw new OmpRuntimeStoppingError(`Fork session ${source.id} to ${destination.id}`);
    if (![...deps.reservations.values()].includes(destination.id)) throw new OmpSessionUnavailableError('Fork destination capacity must be reserved', `Fork session ${source.id} to ${destination.id}`);
    const operation = Promise.resolve().then(async () => {
      await deps.acquire();
      assertSessions();
      const pin = await deps.readManagedBinding(source);
      if (target && (!pin || target.ompSessionId !== pin.sessionId)) throw new OmpIdentityError('Fork anchor belongs to a different OMP conversation', `Fork session ${source.id} to ${destination.id}`);
      if (!pin) {
        try {
          await lstat(path.join(deps.config.dataDir, 'sessions', source.id, 'history.jsonl'));
          throw new OmpSessionUnavailableError('Unpinned managed histories require explicit recovery', `Fork session ${source.id} to ${destination.id}`);
        } catch (error) { error = systemError(error, 'fork OS operation'); if (!errno(error, 'ENOENT')) throw error; }
      }
      if (await deps.readManagedBinding(destination) || deps.managed.get(destination.id)) throw new OmpSessionUnavailableError('Fork destination already has an OMP conversation', `Fork session ${source.id} to ${destination.id}`);
      const cwd = pin?.cwd ?? await deps.validatedSessionCwd(source);
      if (pin) {
        const hosts = (await deps.list(Date.now() + deps.config.omp.startupTimeoutMs)).filter(host => host.sessionId === pin.sessionId);
        if (hosts.length > 1 || hosts.some(host => host.busy !== false)) throw new OmpHostBusyError('OMP host is busy; wait for the current turn and queued messages to finish before forking', `Fork session ${source.id} to ${destination.id}`);
      }
      assertSessions();
      await beforeMutation?.();
      assertSessions();
      const dir = path.resolve(deps.config.dataDir, 'sessions', destination.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OmpProtocolError('Fork managed session', `source ${source.id}; destination ${destination.id}`, 'Managed session directory is invalid');
      await chmod(dir, 0o700);
      if ((await readdir(dir)).some(file => file.endsWith('.jsonl') || file === 'binding.json')) throw new OmpSessionUnavailableError('Fork destination already has an OMP conversation', `Fork session ${source.id} to ${destination.id}`);
      const scratch = await mkdtemp(path.join(dir, 'fork-'));
      const finalFile = path.join(dir, 'history.jsonl');
      let moved = false;
      let published = false;
      try {
        const snapshot = path.join(scratch, 'history.jsonl');
        const id = randomUUID();
        const contents = pin ? await readFile(pin.sessionFile, 'utf8') : `${JSON.stringify({ type: 'session', version: 3, timestamp: new Date().toISOString(), cwd })}\n`;
        const headerStart = parseObject(contents.slice(0, contents.indexOf('\n')), 'Fork history', `source ${source.id}; destination ${destination.id}`).type === 'title'
          ? contents.indexOf('\n') + 1 : 0;
        const newline = contents.indexOf('\n', headerStart);
        const header = parseObject(contents.slice(headerStart, newline), 'Fork history', `source ${source.id}; destination ${destination.id}`) as Record<string, unknown>;
        if (header.type !== 'session' || (pin && (header.id !== pin.sessionId || header.cwd !== cwd))) throw new OmpIdentityError('Managed OMP history identity changed', `Fork session ${source.id} to ${destination.id}`);
        header.id = id;
        const titleSlot = contents.slice(0, headerStart);
        await privateFile(snapshot, `${titleSlot}${JSON.stringify(header)}\n${contents.slice(newline + 1)}`, true);
        const copyArtifacts = async (from: string, to: string) => {
          try { await lstat(from); }
          catch (error) { error = systemError(error, 'fork OS operation'); if (errno(error, 'ENOENT')) return; throw error; }
          await cp(from, to, { recursive: true, errorOnExist: true, force: false });
        };
        const artifactPath = (file: string) => file.replace(/\.jsonl$/, '');
        if (pin) await copyArtifacts(artifactPath(pin.sessionFile), artifactPath(snapshot));
        const config = path.join(scratch, 'runtime.yml');
        await privateFile(config, JSON.stringify({ collab: { autoStart: false }, startup: { checkUpdate: false, setupWizard: false } }));
        const tree = await deps.forkRpc(snapshot, cwd, config, { type: 'get_tree' });
        if (!Array.isArray(tree.tree) || !(tree.leafId === null || typeof tree.leafId === 'string')) throw new OmpProtocolError('Fork managed session', `source ${source.id}; destination ${destination.id}`, 'Native OMP returned an invalid session tree');
        const entries = new Map<string, Record<string, unknown>>();
        const visit = (nodes: unknown[]) => {
          for (const node of nodes) {
            if (!record(node) || !record(node.entry) || typeof node.entry.id !== 'string' || !Array.isArray(node.children)) throw new OmpProtocolError('Fork managed session', `source ${source.id}; destination ${destination.id}`, 'Native OMP returned an invalid session tree');
            entries.set(node.entry.id, node.entry);
            visit(node.children);
          }
        };
        visit(tree.tree);
        const branch: Record<string, unknown>[] = [];
        let leaf = tree.leafId;
        const seen = new Set<string>();
        while (typeof leaf === 'string') {
          const entry = entries.get(leaf);
          if (!entry || seen.has(leaf)) throw new OmpProtocolError('Fork managed session', `source ${source.id}; destination ${destination.id}`, 'Native OMP returned an invalid active branch');
          seen.add(leaf);
          branch.push(entry);
          const parent = entry.parentId;
          if (parent !== null && typeof parent !== 'string') throw new OmpProtocolError('Fork managed session', `source ${source.id}; destination ${destination.id}`, 'Native OMP returned an invalid active branch');
          leaf = parent;
        }
        if (target) {
          const selected = branch.find(entry => entry.id === target.entryId);
          if (!selected || selected.parentId !== target.parentEntryId ||
              (target.kind === 'assistant' ? !(selected.type === 'message' && record(selected.message) && selected.message.role === 'assistant')
                : !(selected.type === 'custom_message' && selected.customType === 'collab-prompt'))) throw new OmpSessionUnavailableError('Fork anchor is not on the current active branch', `Fork ${source.id} at ${target?.entryId}`);
          if (target.kind === 'collab-prompt') {
            const selectedPath = branch.slice(branch.indexOf(selected)).reverse();
            await privateFile(snapshot, titleSlot + [header, ...selectedPath].map(entry => JSON.stringify(entry)).join('\n') + '\n');
          }
        }
        assertSessions();
        const current = await deps.readManagedBinding(source);
        if (current?.sessionId !== pin?.sessionId || current?.sessionFile !== pin?.sessionFile) throw new OmpIdentityError('Managed OMP conversation changed while forking', `Fork session ${source.id} to ${destination.id}`);
        if (pin && await readFile(pin.sessionFile, 'utf8') !== contents) throw new OmpIdentityError('Managed OMP active history changed while forking', `Fork session ${source.id} to ${destination.id}`);
        const state = await deps.forkRpc(snapshot, cwd, config, { type: 'fork', ...(target?.kind === 'assistant' ? { entryId: target.entryId } : {}) });
        if (typeof state.sessionId !== 'string' || state.sessionId === id || state.sessionId === pin?.sessionId || typeof state.sessionFile !== 'string') throw new OmpProtocolError('Fork managed session', `source ${source.id}; destination ${destination.id}`, 'Native OMP fork returned an invalid session identity');
        const nativeFile = await realpath(state.sessionFile);
        if (!nativeFile.startsWith(`${scratch}${path.sep}`)) throw new OmpIdentityError('Native OMP fork escaped its destination directory', `Fork session ${source.id} to ${destination.id}`);
        const forkHeader = await readHeader(nativeFile);
        if (forkHeader.id !== state.sessionId || forkHeader.cwd !== cwd) throw new OmpIdentityError('Native OMP fork history identity changed', `Fork session ${source.id} to ${destination.id}`);
        const forkContents = await readFile(nativeFile, 'utf8');
        const forkHeaderStart = parseObject(forkContents.slice(0, forkContents.indexOf('\n')), 'Fork history', `source ${source.id}; destination ${destination.id}`).type === 'title'
          ? forkContents.indexOf('\n') + 1 : 0;
        const forkNewline = forkContents.indexOf('\n', forkHeaderStart);
        const nativeHeader = parseObject(forkContents.slice(forkHeaderStart, forkNewline), 'Fork history', `source ${source.id}; destination ${destination.id}`) as Record<string, unknown>;
        if (pin) nativeHeader.parentSession = target ? pin.sessionFile : pin.sessionId;
        else delete nativeHeader.parentSession;
        await privateFile(nativeFile, `${forkContents.slice(0, forkHeaderStart)}${JSON.stringify(nativeHeader)}\n${forkContents.slice(forkNewline + 1)}`);
        await beforeMutation?.();
        assertSessions();
        await rename(nativeFile, finalFile);
        moved = true;
        try { await rename(artifactPath(nativeFile), artifactPath(finalFile)); }
        catch (error) { error = systemError(error, 'fork OS operation'); if (!errno(error, 'ENOENT')) throw error; }
        await chmod(finalFile, 0o600);
        await beforeMutation?.();
        assertSessions();
        await writeBinding(dir, { version: 1, sessionId: state.sessionId, sessionFile: finalFile, cwd });
        published = true;
        destination.cwd = cwd;
      } finally {
        await rm(scratch, { recursive: true, force: true });
        if (moved && !published) {
          await rm(finalFile, { force: true });
          await rm(finalFile.replace(/\.jsonl$/, ''), { recursive: true, force: true });
          await rm(path.join(dir, 'binding.json'), { force: true });
        }
      }
    });
    forks.add(operation);
    const stopping = operation.then(() => undefined, () => undefined);
    deps.stopping.set(source.id, stopping);
    deps.stopping.set(destination.id, stopping);
    try { await operation; }
    finally {
      forks.delete(operation);
      if (deps.stopping.get(source.id) === stopping) deps.stopping.delete(source.id);
      if (deps.stopping.get(destination.id) === stopping) deps.stopping.delete(destination.id);
    }
  }
  async function drain(): Promise<void> { await settleOperations(forks, 'Drain runtime forks'); }
  return { fork, drain };
}

