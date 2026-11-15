import { systemError, parseJson, OmpIdentityError, OmpSessionUnavailableError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { access, chmod, constants, lstat, mkdir, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import { findInstance } from '../config.js';
import { type DurableBinding, type ManagedHost } from './types.js';
import { privateFile, writeBinding, readHeader } from './files.js';
import { record, errno } from './values.js';
interface PathsDependencies {
  readonly config: AppConfig;
  readonly managed: Map<string, ManagedHost | null>;
}

// This owner keeps the complete paths transaction and its cleanup together.
export interface RuntimePaths {
  validateCwd(cwd: string): Promise<void>;
  validatedSessionCwd(session: TopicSession): Promise<string>;
  validateSessionPaths(sessions: TopicSession[], config?: AppConfig): Promise<void>;
  readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined>;
  prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }>;
}

export function createPaths(deps: PathsDependencies): RuntimePaths {

  async function validateCwd(cwd: string): Promise<void> {
    if (await realpath(cwd) !== cwd) throw new OmpIdentityError('Managed working directory identity changed', `Validate working directory ${cwd}`);
    const directory = await opendir(cwd);
    await directory.close();
    await access(cwd, constants.R_OK | constants.X_OK);
  }

  async function validatedSessionCwd(session: TopicSession): Promise<string> {
    const cwd = session.cwd;
    await validateCwd(cwd);
    return cwd;
  }

  async function validateSessionPaths(sessions: TopicSession[], config = deps.config): Promise<void> {
    for (const session of sessions) {
      const assigned = findInstance(config, session.botId, session.chatId);
      if (assigned && session.instanceId !== assigned.instance.id) throw new OmpIdentityError(`Chat ${session.chatId} has history pinned to another instance ID`, `Managed session ${session.id}`);
    }
    for (const session of sessions) {
      if (session.runtime.kind !== 'managed') continue;
      try {
        const directory = path.resolve(config.dataDir, 'sessions', session.id);
        let contents: string;
        try {
          contents = await readFile(path.join(directory, 'binding.json'), 'utf8');
        } catch (error) { error = systemError(error, 'paths OS operation');
          if (errno(error, 'ENOENT')) continue;
          throw error;
        }
        const pin: unknown = parseJson(contents, 'Read managed binding', `session ${session.id}`);
        if (!record(pin) || pin.version !== 1 || typeof pin.cwd !== 'string' || !path.isAbsolute(pin.cwd) ||
            typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) ||
            typeof pin.sessionId !== 'string' || !pin.sessionId) throw new OmpIdentityError('Managed OMP binding is incompatible with this configuration', `Managed session ${session.id}`);
        const header = await readHeader(pin.sessionFile);
        if (header.id !== pin.sessionId || header.cwd !== pin.cwd) throw new OmpIdentityError('Managed OMP history identity changed', `Managed session ${session.id}`);
        await validateCwd(pin.cwd);
        session.cwd = pin.cwd;
      } catch (error) { error = systemError(error, 'paths OS operation');
        console.error(`Session ${session.id} recovery failed:`, error);
      }
    }
  }

  async function readManagedBinding(session: TopicSession): Promise<DurableBinding | undefined> {
    const metadata = path.join(deps.config.dataDir, 'sessions', session.id, 'binding.json');
    let pin: DurableBinding;
    try {
      if (!(await lstat(metadata)).isFile()) throw new OmpIdentityError('Invalid managed binding metadata', `Managed session ${session.id}`);
      pin = parseJson(await readFile(metadata, 'utf8'), 'Read runtime metadata', `session ${session.id}`) as DurableBinding;
    } catch (error) { error = systemError(error, 'paths OS operation');
      if (!errno(error, 'ENOENT')) throw error;
      if (deps.managed.get(session.id)) throw new OmpIdentityError('Managed OMP binding is missing', `Managed session ${session.id}`);
      return undefined;
    }
    const cwd = await validatedSessionCwd(session);
    if (!record(pin) || pin.version !== 1 || typeof pin.sessionFile !== 'string' ||
        !path.isAbsolute(pin.sessionFile) || pin.cwd !== cwd || typeof pin.sessionId !== 'string' || !pin.sessionId) {
      throw new OmpIdentityError('Managed OMP binding is incompatible with this configuration', `Managed session ${session.id}`);
    }
    const header = await readHeader(pin.sessionFile);
    const owned = deps.managed.get(session.id);
    if (header.id !== pin.sessionId || header.cwd !== pin.cwd || (owned && owned.sessionId !== pin.sessionId)) {
      throw new OmpIdentityError('Managed OMP history identity changed', `Managed session ${session.id}`);
    }
    return pin;
  }

  async function prepare(session: TopicSession): Promise<{ dir: string; pin: DurableBinding }> {
    const dir = path.resolve(deps.config.dataDir, 'sessions', session.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OmpIdentityError('Managed session directory is invalid', `Managed session ${session.id}`);
    await chmod(dir, 0o700);
    const cwd = await validatedSessionCwd(session);
    const sessionFile = path.join(dir, 'history.jsonl');
    let pin: DurableBinding | undefined;
    try {
      const metadata = path.join(dir, 'binding.json');
      if (!(await lstat(metadata)).isFile()) throw new OmpIdentityError('Invalid managed binding metadata', `Managed session ${session.id}`);
      pin = parseJson(await readFile(metadata, 'utf8'), 'Read runtime metadata', `session ${session.id}`) as DurableBinding;
      if (pin.version !== 1 || typeof pin.sessionFile !== 'string' || !path.isAbsolute(pin.sessionFile) || pin.cwd !== cwd || typeof pin.sessionId !== 'string' || !pin.sessionId) {
        throw new OmpIdentityError('Managed OMP binding is incompatible with this configuration', `Managed session ${session.id}`);
      }
      await chmod(metadata, 0o600);
    } catch (error) { error = systemError(error, 'paths OS operation');
      if (!errno(error, 'ENOENT')) throw error;
    }
    if (!pin) {
      let header: { id: string; cwd: string };
      try {
        header = await readHeader(sessionFile);
      } catch (error) { error = systemError(error, 'paths OS operation');
        if (!errno(error, 'ENOENT')) throw error;
        if ((await readdir(dir)).some(file => file.endsWith('.jsonl'))) throw new OmpSessionUnavailableError('Unpinned managed histories require explicit recovery', `Managed session ${session.id}`);
        const value = { type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
        await privateFile(sessionFile, `${JSON.stringify(value)}\n`, true);
        header = value;
      }
      if (header.cwd !== cwd) throw new OmpIdentityError('Managed history working directory changed', `Managed session ${session.id}`);
      pin = { version: 1, sessionId: header.id, sessionFile, cwd };
      await writeBinding(dir, pin);
    }
    const header = await readHeader(pin.sessionFile);
    if (header.id !== pin.sessionId || header.cwd !== pin.cwd) throw new OmpIdentityError('Managed OMP history identity changed', `Managed session ${session.id}`);
    await chmod(pin.sessionFile, 0o600);
    return { dir, pin };
  }

  return { validateCwd, validatedSessionCwd, validateSessionPaths, readManagedBinding, prepare };
}

