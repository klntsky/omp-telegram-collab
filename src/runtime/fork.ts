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
      if (deps.closed) throw new Error('OMP runtime is stopping');
      for (const session of [source, destination]) {
        if (session.status !== 'open') throw new Error('Session closed');
        if (session.runtime.kind !== 'managed') throw new Error('Attached OMP sessions cannot be forked');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error('Invalid managed session identifier');
      }
      if (source.id === destination.id) throw new Error('Fork destination must be independent');
      if (source.instanceId !== destination.instanceId || !deps.config.instances.some(instance => instance.id === source.instanceId)) {
        throw new Error('Fork sessions must belong to the same configured instance');
      }
      const activity = deps.hostActivity(source.id);
      if (activity.busy || deps.pending.has(source.id)) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before forking');
    };
    assertSessions();
    if ([source, destination].some(session => deps.stopping.has(session.id) || deps.pending.has(session.id))) throw new Error('OMP runtime is stopping');
    if (![...deps.reservations.values()].includes(destination.id)) throw new Error('Fork destination capacity must be reserved');
    const operation = Promise.resolve().then(async () => {
      await deps.acquire();
      assertSessions();
      const pin = await deps.readManagedBinding(source);
      if (pin?.removedWorktree) throw new Error(`This session's worktree was deleted: ${pin.cwd}`);
      if (target && (!pin || target.ompSessionId !== pin.sessionId)) throw new Error('Fork anchor belongs to a different OMP conversation');
      if (!pin) {
        try {
          await lstat(path.join(deps.config.dataDir, 'sessions', source.id, 'history.jsonl'));
          throw new Error('Unpinned managed histories require explicit recovery');
        } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
      }
      if (await deps.readManagedBinding(destination) || deps.managed.get(destination.id)) throw new Error('Fork destination already has an OMP conversation');
      const cwd = pin?.cwd ?? await deps.validatedSessionCwd(source);
      if (pin) {
        const hosts = (await deps.list(Date.now() + deps.config.omp.startupTimeoutMs)).filter(host => host.sessionId === pin.sessionId);
        if (hosts.length > 1 || hosts.some(host => host.busy !== false)) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before forking');
      }
      assertSessions();
      await beforeMutation?.();
      assertSessions();
      const dir = path.resolve(deps.config.dataDir, 'sessions', destination.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed session directory is invalid');
      await chmod(dir, 0o700);
      if ((await readdir(dir)).some(file => file.endsWith('.jsonl') || file === 'binding.json')) throw new Error('Fork destination already has an OMP conversation');
      const scratch = await mkdtemp(path.join(dir, 'fork-'));
      const finalFile = path.join(dir, 'history.jsonl');
      let moved = false;
      let published = false;
      try {
        const snapshot = path.join(scratch, 'history.jsonl');
        const id = randomUUID();
        const contents = pin ? await readFile(pin.sessionFile, 'utf8') : `${JSON.stringify({ type: 'session', version: 3, timestamp: new Date().toISOString(), cwd })}\n`;
        const headerStart = JSON.parse(contents.slice(0, contents.indexOf('\n'))).type === 'title'
          ? contents.indexOf('\n') + 1 : 0;
        const newline = contents.indexOf('\n', headerStart);
        const header = JSON.parse(contents.slice(headerStart, newline)) as Record<string, unknown>;
        if (header.type !== 'session' || (pin && (header.id !== pin.sessionId || header.cwd !== cwd))) throw new Error('Managed OMP history identity changed');
        header.id = id;
        const titleSlot = contents.slice(0, headerStart);
        await privateFile(snapshot, `${titleSlot}${JSON.stringify(header)}\n${contents.slice(newline + 1)}`, true);
        const copyArtifacts = async (from: string, to: string) => {
          try { await lstat(from); }
          catch (error) { if (errno(error, 'ENOENT')) return; throw error; }
          await cp(from, to, { recursive: true, errorOnExist: true, force: false });
        };
        const artifactPath = (file: string) => file.replace(/\.jsonl$/, '');
        if (pin) await copyArtifacts(artifactPath(pin.sessionFile), artifactPath(snapshot));
        const config = path.join(scratch, 'runtime.yml');
        await privateFile(config, JSON.stringify({ collab: { autoStart: false }, startup: { checkUpdate: false, setupWizard: false } }));
        const tree = await deps.forkRpc(snapshot, cwd, config, { type: 'get_tree' });
        if (!Array.isArray(tree.tree) || !(tree.leafId === null || typeof tree.leafId === 'string')) throw new Error('Native OMP returned an invalid session tree');
        const entries = new Map<string, Record<string, unknown>>();
        const visit = (nodes: unknown[]) => {
          for (const node of nodes) {
            if (!record(node) || !record(node.entry) || typeof node.entry.id !== 'string' || !Array.isArray(node.children)) throw new Error('Native OMP returned an invalid session tree');
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
          if (!entry || seen.has(leaf)) throw new Error('Native OMP returned an invalid active branch');
          seen.add(leaf);
          branch.push(entry);
          const parent = entry.parentId;
          if (parent !== null && typeof parent !== 'string') throw new Error('Native OMP returned an invalid active branch');
          leaf = parent;
        }
        if (target) {
          const selected = branch.find(entry => entry.id === target.entryId);
          if (!selected || selected.parentId !== target.parentEntryId ||
              (target.kind === 'assistant' ? !(selected.type === 'message' && record(selected.message) && selected.message.role === 'assistant')
                : !(selected.type === 'custom_message' && selected.customType === 'collab-prompt'))) throw new Error('Fork anchor is not on the current active branch');
          if (target.kind === 'collab-prompt') {
            const selectedPath = branch.slice(branch.indexOf(selected)).reverse();
            await privateFile(snapshot, titleSlot + [header, ...selectedPath].map(entry => JSON.stringify(entry)).join('\n') + '\n');
          }
        }
        assertSessions();
        const current = await deps.readManagedBinding(source);
        if (current?.sessionId !== pin?.sessionId || current?.sessionFile !== pin?.sessionFile) throw new Error('Managed OMP conversation changed while forking');
        if (pin && await readFile(pin.sessionFile, 'utf8') !== contents) throw new Error('Managed OMP active history changed while forking');
        const state = await deps.forkRpc(snapshot, cwd, config, { type: 'fork', ...(target?.kind === 'assistant' ? { entryId: target.entryId } : {}) });
        if (typeof state.sessionId !== 'string' || state.sessionId === id || state.sessionId === pin?.sessionId || typeof state.sessionFile !== 'string') throw new Error('Native OMP fork returned an invalid session identity');
        const nativeFile = await realpath(state.sessionFile);
        if (!nativeFile.startsWith(`${scratch}${path.sep}`)) throw new Error('Native OMP fork escaped its destination directory');
        const forkHeader = await readHeader(nativeFile);
        if (forkHeader.id !== state.sessionId || forkHeader.cwd !== cwd) throw new Error('Native OMP fork history identity changed');
        const forkContents = await readFile(nativeFile, 'utf8');
        const forkHeaderStart = JSON.parse(forkContents.slice(0, forkContents.indexOf('\n'))).type === 'title'
          ? forkContents.indexOf('\n') + 1 : 0;
        const forkNewline = forkContents.indexOf('\n', forkHeaderStart);
        const nativeHeader = JSON.parse(forkContents.slice(forkHeaderStart, forkNewline)) as Record<string, unknown>;
        if (pin) nativeHeader.parentSession = target ? pin.sessionFile : pin.sessionId;
        else delete nativeHeader.parentSession;
        await privateFile(nativeFile, `${forkContents.slice(0, forkHeaderStart)}${JSON.stringify(nativeHeader)}\n${forkContents.slice(forkNewline + 1)}`);
        await beforeMutation?.();
        assertSessions();
        await rename(nativeFile, finalFile);
        moved = true;
        try { await rename(artifactPath(nativeFile), artifactPath(finalFile)); }
        catch (error) { if (!errno(error, 'ENOENT')) throw error; }
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
  async function drain(): Promise<void> { await Promise.allSettled(forks); }
  return { fork, drain };
}

