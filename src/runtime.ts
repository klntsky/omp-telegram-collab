import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as pty from '@lydell/node-pty';
import type { AppConfig, HostBinding, TopicSession } from '../shared/contracts.js';
import { parseCollabLink } from './vendor/link.js';

interface RegistryHost {
  instanceId: string;
  sessionId: string;
  generation: number;
  pid: number;
  cwd: string;
  access: 'view' | 'control';
  relayConnected: boolean;
}

interface DurableBinding {
  version: 1;
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

interface ManagedHost {
  terminal?: pty.IPty;
  binding?: HostBinding;
  exited: boolean;
  exit: Promise<void>;
  group: boolean;
  failure?: string;
  shutdown?: Promise<void>;
}

const FORBIDDEN_ARGS: Record<string, true> = {
  '--session': true, '-s': true, '--session-dir': true, '--resume': true, '-r': true,
  '--continue': true, '-c': true, '--no-session': true, '--restore': true, '--fork': true,
  '--mode': true, '--print': true, '-p': true, '--goal': true, '--cwd': true,
  '--help': true, '-h': true, '--version': true,
};

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (!errno(error, 'ESRCH')) throw error;
  }
}

async function procIdentity(pid: number): Promise<{ parent: number; group: number } | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { parent: Number(fields[1]), group: Number(fields[2]) };
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
  #closed = false;
  #closing?: Promise<void>;
  #lock?: DatabaseSync;
  #acquiring?: Promise<void>;

  constructor(config: AppConfig) {
    if (!Number.isInteger(config.omp.maxSessions) || config.omp.maxSessions < 1 || !Number.isFinite(config.omp.startupTimeoutMs) || config.omp.startupTimeoutMs < 1) {
      throw new Error('Invalid OMP runtime limits');
    }
    for (const arg of config.omp.args) {
      const flag = arg.split('=', 1)[0]!;
      if (Object.hasOwn(FORBIDDEN_ARGS, flag) || flag.startsWith('--from-')) throw new Error(`OMP argument ${flag} conflicts with managed hosting`);
    }
    this.#config = config;
  }

  ensure(session: TopicSession): Promise<HostBinding> {
    if (this.#closed || this.#stopping.has(session.id)) return Promise.reject(new Error('OMP runtime is stopping'));
    const pending = this.#pending.get(session.id);
    if (pending) return pending;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return Promise.reject(new Error('Invalid managed session identifier'));
    if (session.runtime.kind === 'managed' && !this.#managed.has(session.id)) {
      if (this.#managed.size >= this.#config.omp.maxSessions) return Promise.reject(new Error('OMP managed session limit reached'));
      this.#managed.set(session.id, null);
    }
    const operation = session.runtime.kind === 'managed'
      ? this.#ensureManaged(session.id)
      : this.attach(session.runtime.instanceId).then(binding => {
        if (session.runtime.kind !== 'attached' || binding.sessionId !== session.runtime.sessionId) {
          throw new Error('Attached OMP session identity changed');
        }
        return binding;
      });
    const result = operation.finally(() => this.#pending.delete(session.id));
    this.#pending.set(session.id, result);
    return result;
  }

  async attach(instanceId: string): Promise<HostBinding> {
    if (this.#closed) throw new Error('OMP runtime is stopping');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Invalid OMP instance identifier');
    await this.#acquire();
    if (this.#closed) throw new Error('OMP runtime is stopping');
    const deadline = Date.now() + this.#config.omp.startupTimeoutMs;
    const host = (await this.#list(deadline)).find(candidate => candidate.instanceId === instanceId);
    if (!host) throw new Error('OMP host is not available');
    const binding = await this.#resolve(host, deadline);
    if (this.#closed) throw new Error('OMP runtime is stopping');
    return binding;
  }

  stop(id: string): Promise<void> {
    const pending = this.#stopping.get(id);
    if (pending) return pending;
    const operation = (async () => {
      await this.#pending.get(id)?.catch(() => undefined);
      const host = this.#managed.get(id);
      if (host) await this.#shutdown(host);
      this.#managed.delete(id);
    })().finally(() => this.#stopping.delete(id));
    this.#stopping.set(id, operation);
    return operation;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await Promise.allSettled(this.#pending.values());
      await this.#acquiring?.catch(() => undefined);
      const results = await Promise.allSettled([...this.#managed.keys()].map(id => this.stop(id)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      this.#lock?.close();
      this.#lock = undefined;
    })();
    return this.#closing;
  }

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
        if (this.#closed) throw new Error('OMP runtime is stopping');
        this.#lock = database;
      } catch (error) {
        database?.close();
        throw new Error('Cannot acquire exclusive OMP runtime ownership for dataDir', { cause: error });
      }
    })();
    return this.#acquiring;
  }

  async #prepare(id: string): Promise<{ dir: string; pin: DurableBinding }> {
    const dir = path.resolve(this.#config.dataDir, 'sessions', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed session directory is invalid');
    await chmod(dir, 0o700);
    const cwd = await realpath(this.#config.omp.cwd);
    const sessionFile = path.join(dir, 'history.jsonl');
    let pin: DurableBinding | undefined;
    try {
      const metadata = path.join(dir, 'binding.json');
      if (!(await lstat(metadata)).isFile()) throw new Error('Invalid managed binding metadata');
      pin = JSON.parse(await readFile(metadata, 'utf8')) as DurableBinding;
      if (pin.version !== 1 || pin.sessionFile !== sessionFile || pin.cwd !== cwd || typeof pin.sessionId !== 'string' || !pin.sessionId) {
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
    const overlay = {
      collab: { autoStart: 'control', ...(this.#config.omp.relayUrl ? { relayUrl: this.#config.omp.relayUrl } : {}) },
      startup: { checkUpdate: false, setupWizard: false },
    };
    await privateFile(path.join(dir, 'runtime.yml'), JSON.stringify(overlay));
    return { dir, pin };
  }

  async #ensureManaged(id: string): Promise<HostBinding> {
    let owned = this.#managed.get(id);
    const deadline = Date.now() + this.#config.omp.startupTimeoutMs;
    try {
      await this.#acquire();
      const { dir, pin } = await this.#prepare(id);
      if (this.#closed || this.#stopping.has(id)) throw new Error('OMP runtime is stopping');
      if (owned?.exited) {
        await this.#shutdown(owned);
        owned = undefined;
        this.#managed.set(id, null);
      }
      let hosts = await this.#list(deadline);
      if (owned?.binding) {
        const instanceId = owned.binding.instanceId;
        const previous = hosts.find(host => host.instanceId === instanceId);
        if (previous && previous.sessionId !== pin.sessionId) throw new Error('Managed OMP process switched its pinned session');
      }
      if (!owned?.terminal) {
        const matches = hosts.filter(host => host.sessionId === pin.sessionId);
        if (matches.length > 1) throw new Error('More than one host is serving the managed OMP session');
        if (matches.length === 1) {
          const host = matches[0]!;
          if (await realpath(host.cwd) !== pin.cwd) throw new Error('Managed host working directory changed');
          const binding = await this.#resolve(host, deadline);
          this.#managed.set(id, { binding, exited: false, exit: Promise.resolve(), group: false });
          return binding;
        }
        const terminal = pty.spawn(this.#config.omp.executable, [
          ...this.#config.omp.args,
          '--cwd', pin.cwd,
          '--config', path.join(dir, 'runtime.yml'),
          '--session-dir', dir,
          '--resume', pin.sessionFile,
          '--no-title',
        ], {
          cwd: pin.cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
        });
        let exit!: () => void;
        owned = { terminal, exited: false, exit: new Promise<void>(resolve => { exit = resolve; }), group: process.platform !== 'win32' };
        this.#managed.set(id, owned);
        const record = owned;
        terminal.onData(() => undefined);
        const emitter = terminal as pty.IPty & { on?: (event: string, listener: () => void) => void };
        emitter.on?.('error', () => {
          record.failure = 'Managed OMP terminal failed';
          void this.#shutdown(record).catch(() => undefined);
        });
        terminal.onExit(() => {
          record.exited = true;
          exit();
          void this.#shutdown(record).then(() => {
            if (this.#managed.get(id) === record) this.#managed.delete(id);
          }).catch(() => undefined);
        });
        const identity = await procIdentity(terminal.pid);
        if (identity) owned.group = identity.group === terminal.pid;
      }
      while (Date.now() < deadline) {
        if (this.#closed || this.#stopping.has(id)) throw new Error('OMP runtime is stopping');
        if (owned.failure) throw new Error(owned.failure);
        if (owned.exited) throw new Error('Managed OMP process exited before its host was available');
        const terminal = owned.terminal!;
        for (const host of hosts) {
          if (!await belongsTo(host.pid, terminal.pid)) continue;
          if (host.sessionId !== pin.sessionId || await realpath(host.cwd) !== pin.cwd) {
            throw new Error('Managed OMP process switched its pinned session');
          }
          const binding = await this.#resolve(host, deadline);
          owned.binding = binding;
          return binding;
        }
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        hosts = await this.#list(deadline);
      }
      throw new Error('Managed OMP startup timed out');
    } catch (error) {
      if (owned?.terminal) await this.#shutdown(owned);
      this.#managed.delete(id);
      throw error;
    }
  }

  async #json(args: string[], deadline: number): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('OMP discovery timed out');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(this.#config.omp.executable, args, {
        cwd: this.#config.omp.cwd,
        env: process.env,
        timeout: Math.min(remaining, 5_000),
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout) => error ? reject(new Error('OMP discovery command failed')) : resolve(stdout));
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

  #shutdown(host: ManagedHost): Promise<void> {
    if (host.shutdown) return host.shutdown;
    host.shutdown = (async () => {
      const terminal = host.terminal;
      if (!terminal) return;
      if (!host.exited) signal(terminal.pid, 'SIGTERM');
      await Promise.race([host.exit, delay(2_000)]);
      if (host.group) {
        signal(-terminal.pid, 'SIGTERM');
        await delay(250);
        signal(-terminal.pid, 'SIGKILL');
      } else if (!host.exited) {
        terminal.kill('SIGKILL');
      }
      await Promise.race([host.exit, delay(1_000)]);
      if (!host.exited) throw new Error('Managed OMP process did not exit after shutdown escalation');
    })();
    return host.shutdown;
  }
}
