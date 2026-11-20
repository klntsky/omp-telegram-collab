import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { SessionTitleUnsupportedError, type RegistryHost, type DurableBinding, type ManagedHost, type HostLifecycle } from './types.js';
import { SessionRetiringError } from './types.js';
import { procIdentity } from './process.js';
import { delay } from './values.js';
import { managedLifecycleIdentity } from './lifecycle-identity.js';
import { isDiscoveryDeadlineError } from './discovery.js';
interface HostControlDependencies {
  readonly config: AppConfig;
  list(deadline: number): Promise<RegistryHost[]>;
  resolve(host: RegistryHost, deadline: number): Promise<HostBinding>;
  assertActive(): void;
  readonly closed: boolean;
  readonly stopping: Map<string, Promise<void>>;
  isRunning(session: TopicSession): Promise<boolean>;
  retain(id: string): () => void;
  ensure(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  readonly managed: Map<string, ManagedHost | null>;
}

// This owner keeps the complete host control transaction and its cleanup together.
export interface RuntimeHostControl {
  setSessionTitle(session: TopicSession, title: string): Promise<void>;
  modelPresets(session: TopicSession, name?: string): Promise<string>;
  hostControl(session: TopicSession, name: string | undefined, type: 'model_presets' | 'list_skills' | 'set_session_title'): Promise<string>;
}

export function createHostControl(deps: HostControlDependencies): RuntimeHostControl {
  async function visibleHosts(
    deadline: number,
    matches: (host: RegistryHost) => boolean,
    pinned: { pid: number; start: string } | undefined,
    diagnostic: string,
  ): Promise<RegistryHost[]> {
    const missing = new Error(diagnostic);
    let omitted = false;
    for (;;) {
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      let hosts: RegistryHost[];
      try {
        hosts = (await deps.list(deadline)).filter(matches);
      } catch (error) {
        if (omitted && Date.now() >= deadline && isDiscoveryDeadlineError(error)) {
          Object.defineProperty(missing, 'cause', { value: error, configurable: true });
          throw missing;
        }
        throw error;
      }
      if (hosts.length) {
        if (pinned) {
          const current = await procIdentity(pinned.pid);
          if (!current || current.start !== pinned.start || current.state === 'Z' || current.state === 'X') throw missing;
        }
        return hosts;
      }
      // A missing IPC status reply is not proof of exit; wait only for this
      // independently pinned lifetime, then require a fresh registry snapshot.
      omitted = true;
      const current = pinned && await procIdentity(pinned.pid);
      if (!current || current.start !== pinned!.start || current.state === 'Z' || current.state === 'X' ||
          Date.now() >= deadline) throw missing;
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    }
  }

  async function runningTitleBinding(session: TopicSession): Promise<HostBinding> {
    const pin = JSON.parse(await readFile(path.join(deps.config.dataDir, 'sessions', session.id, 'binding.json'), 'utf8')) as DurableBinding;
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const owned = deps.managed.get(session.id);
    let identity = owned?.identity;
    if (!identity) {
      const lifecycle = await deps.lifecycle(session.id);
      if (lifecycle) {
        const current = await managedLifecycleIdentity(deps.config.dataDir, session.id,
          owned ?? { sessionId: pin.sessionId, cwd: session.cwd, exited: false, retiring: false }, lifecycle);
        if (current) identity = { pid: lifecycle.pid, start: current.start };
      }
    }
    const hosts = await visibleHosts(deadline, host => host.sessionId === pin.sessionId, identity,
      'OMP host stopped or changed during session title control');
    if (hosts.length !== 1 || hosts[0]!.cwd !== session.cwd ||
        (identity && hosts[0]!.pid !== identity.pid) ||
        (owned?.binding && (hosts[0]!.instanceId !== owned.binding.instanceId ||
          hosts[0]!.generation !== owned.binding.generation))) throw new Error('OMP host stopped or changed during session title control');
    return deps.resolve(hosts[0]!, deadline);
  }

  async function setSessionTitle(session: TopicSession, title: string): Promise<void> {
    deps.assertActive();
    if (!title.trim()) throw new Error('OMP session title cannot be empty');
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (session.runtime.kind === 'attached') {
      throw new SessionTitleUnsupportedError('Session title control is unavailable for this attached OMP host. Rename it with /rename in its terminal; the native collab registry does not support renaming.');
    }
    if (!await deps.isRunning(session)) return;
    await hostControl(session, title, 'set_session_title');
  }

  async function modelPresets(session: TopicSession, name?: string): Promise<string> {
    return hostControl(session, name, 'model_presets');
  }

  async function hostControl(session: TopicSession, name: string | undefined, type: 'model_presets' | 'list_skills' | 'set_session_title'): Promise<string> {
    deps.assertActive();
    if (session.runtime.kind !== 'managed') {
      throw new Error('Model preset control is unavailable for attached OMP hosts. Use a managed topic session or run /modelpreset in the attached host.');
    }
    const release = deps.retain(session.id);
    try {
      const binding = type === 'set_session_title'
        ? await runningTitleBinding(session)
        : await deps.ensure(session);
      const deadline = Date.now() + 15000;
      const lifecycle = await deps.lifecycle(session.id);
      if (type === 'set_session_title' && !lifecycle?.sessionTitles) {
        throw new Error('OMP host does not support session title control. Retire this managed host and rejoin to load the updated lifecycle extension.');
      }
      if (!lifecycle || lifecycle.modelPresets !== 2) {
        throw new Error('OMP host does not support model preset control. Retire this managed host and rejoin to load the updated lifecycle extension.');
      }
      const processIdentity = await procIdentity(lifecycle.pid);
      const pinned = processIdentity ? { pid: lifecycle.pid, start: processIdentity.start } : undefined;
      const validate = async () => {
        deps.assertActive();
        if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
        const hosts = await visibleHosts(deadline,
          host => host.instanceId === binding.instanceId || host.sessionId === binding.sessionId, pinned,
          'OMP host identity changed during model preset control');
        const current = hosts.length === 1 ? hosts[0] : undefined;
        const process = pinned && await procIdentity(pinned.pid);
        const descriptor = await deps.lifecycle(session.id);
        if (!current || current.instanceId !== binding.instanceId ||
            (pinned && (!process || process.start !== pinned.start || process.state === 'Z' || process.state === 'X')) ||
            current.sessionId !== binding.sessionId || current.generation !== binding.generation ||
            current.pid !== lifecycle.pid || current.cwd !== session.cwd ||
            descriptor?.pid !== lifecycle.pid || descriptor.sessionId !== binding.sessionId ||
            descriptor.socketPath !== lifecycle.socketPath || descriptor.modelPresets !== 2) {
          throw new Error('OMP host identity changed during model preset control');
        }
        if (descriptor.retiring || deps.managed.get(session.id)?.retiring) throw new SessionRetiringError('Session is retiring; rejoin after it settles');
      };
      if (lifecycle.sessionId !== binding.sessionId ||
          path.dirname(lifecycle.socketPath) !== tmpdir() ||
          !/^omp-tg-[a-f0-9]{24}\.sock$/.test(path.basename(lifecycle.socketPath))) {
        throw new Error('Invalid OMP model preset control descriptor');
      }
      for (const filename of [path.join(deps.config.dataDir, 'sessions', session.id, 'lifecycle.json'), lifecycle.socketPath]) {
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
          deps.assertActive();
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

  return { setSessionTitle, modelPresets, hostControl };
}

