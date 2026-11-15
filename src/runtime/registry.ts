import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { AppConfig, HostBinding } from '../../shared/contracts.js';
import { parseCollabLink } from '../vendor/link.js';
import { type RegistryHost } from './types.js';
interface RegistryDependencies {
  readonly config: AppConfig;
  assertActive(): void;
  readonly closed: boolean;
  acquire(): Promise<void>;
}

// This owner keeps the complete registry transaction and its cleanup together.
export interface RuntimeRegistry {
  list(deadline: number): Promise<RegistryHost[]>;
  resolve(host: RegistryHost, deadline: number): Promise<HostBinding>;
  attach(instanceId: string, instancePath: string): Promise<HostBinding>;
}

export function createRegistry(deps: RegistryDependencies): RuntimeRegistry {

  async function json(args: string[], deadline: number): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('OMP discovery timed out');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(deps.config.omp.executable, args, {
        cwd: deps.config.dataDir,
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
    } catch (error) {
      throw new Error('OMP discovery returned invalid JSON', { cause: error });
    }
  }

  async function list(deadline: number): Promise<RegistryHost[]> {
    const result = await json(['collab', 'list', '--json'], deadline);
    if (result.version !== 1 || !Array.isArray(result.hosts)) throw new Error('Unsupported OMP Collab registry version');
    for (const host of result.hosts as RegistryHost[]) {
      if (!host || typeof host.instanceId !== 'string' || typeof host.sessionId !== 'string' || typeof host.cwd !== 'string' || !Number.isSafeInteger(host.pid) || host.pid < 1 || !Number.isSafeInteger(host.generation) || host.generation < 1 || (host.access !== 'view' && host.access !== 'control') || typeof host.relayConnected !== 'boolean') {
        throw new Error('Invalid OMP Collab registry host');
      }
    }
    return result.hosts as RegistryHost[];
  }

  async function resolve(host: RegistryHost, deadline: number): Promise<HostBinding> {
    deps.assertActive();
    if (host.access !== 'control' || !host.relayConnected) throw new Error('OMP host does not publish a connected control room');
    const link = await json(['collab', 'link', host.instanceId, '--json'], deadline);
    if (link.version !== 1 || link.instanceId !== host.instanceId || link.generation !== host.generation || link.access !== 'control' || typeof link.url !== 'string') {
      throw new Error('OMP host changed while resolving its capability');
    }
    const parsed = parseCollabLink(link.url);
    if ('error' in parsed || !parsed.writeToken) throw new Error('OMP host returned an invalid control capability');
    const matches = (await list(deadline)).filter(candidate => candidate.instanceId === host.instanceId || candidate.sessionId === host.sessionId);
    if (matches.length > 1) throw new Error('More than one host is serving the OMP session');
    const current = matches[0];
    if (!current || current.instanceId !== host.instanceId || current.sessionId !== host.sessionId ||
        current.generation !== host.generation || current.pid !== host.pid || current.cwd !== host.cwd) {
      throw new Error('OMP host session changed while resolving its capability');
    }
    return { instanceId: host.instanceId, sessionId: host.sessionId, generation: host.generation, url: link.url };
  }

  async function attach(instanceId: string, instancePath: string): Promise<HostBinding> {
    deps.assertActive();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Invalid OMP instance identifier');
    await deps.acquire();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const host = (await list(deadline)).find(candidate => candidate.instanceId === instanceId);
    if (!host) throw new Error('OMP host is not available');
    if (await realpath(instancePath) !== instancePath || await realpath(host.cwd) !== instancePath) throw new Error('Attached host does not belong to this instance path');
    const binding = await resolve(host, deadline);
    if (deps.closed) throw new Error('OMP runtime is stopping');
    deps.assertActive();
    return binding;
  }

  return { list, resolve, attach };
}

