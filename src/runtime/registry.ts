import { systemError, OmpIdentityError, OmpConfigurationError, OmpSessionUnavailableError, parseJson, OmpRuntimeStoppingError, OmpDiscoveryTimeoutError, OmpCommandError, OmpProtocolError, OmpHostUnavailableError } from './errors.js';
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
    if (remaining <= 0) throw new OmpDiscoveryTimeoutError();
    const output = await new Promise<string>((resolve, reject) => {
      execFile(deps.config.omp.executable, args, {
        cwd: deps.config.dataDir,
        env: process.env,
        timeout: Math.min(remaining, 5_000),
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        // Native collab CLI has no machine-readable missing-host discriminator.
        if (args[0] === 'collab' && args[1] === 'link' && error.code === 1 &&
            stderr.endsWith(`error: no active Collab host matches ${args[2]}\n`)) {
          reject(new OmpHostUnavailableError(args[2]!, error));
        } else reject(new OmpCommandError('OMP discovery', `cwd ${deps.config.dataDir}; command ${args[0]} ${args[1]}`, error, error.code, error.signal));
      });
    });
    try {
      const value = parseJson(output, 'OMP discovery', `cwd ${deps.config.dataDir}; command ${args[0]} ${args[1]}`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OmpProtocolError('OMP discovery', `cwd ${deps.config.dataDir}`, 'Expected a JSON object');
      return value as Record<string, unknown>;
    } catch (error) { error = systemError(error, 'registry OS operation');
      throw error;
    }
  }

  async function list(deadline: number): Promise<RegistryHost[]> {
    const result = await json(['collab', 'list', '--json'], deadline);
    if (result.version !== 1 || !Array.isArray(result.hosts)) throw new OmpProtocolError('Resolve OMP host', `dataDir ${deps.config.dataDir}`, 'Unsupported OMP Collab registry version');
    for (const host of result.hosts as RegistryHost[]) {
      if (!host || typeof host.instanceId !== 'string' || typeof host.sessionId !== 'string' || typeof host.cwd !== 'string' || !Number.isSafeInteger(host.pid) || host.pid < 1 || !Number.isSafeInteger(host.generation) || host.generation < 1 || (host.access !== 'view' && host.access !== 'control') || typeof host.relayConnected !== 'boolean') {
        throw new OmpProtocolError('Resolve OMP host', `dataDir ${deps.config.dataDir}`, 'Invalid OMP Collab registry host');
      }
    }
    return result.hosts as RegistryHost[];
  }

  async function resolve(host: RegistryHost, deadline: number): Promise<HostBinding> {
    deps.assertActive();
    if (host.access !== 'control' || !host.relayConnected) throw new OmpProtocolError('Resolve OMP host', `dataDir ${deps.config.dataDir}`, 'OMP host does not publish a connected control room');
    const link = await json(['collab', 'link', host.instanceId, '--json'], deadline);
    if (link.version !== 1 || link.instanceId !== host.instanceId || link.generation !== host.generation || link.access !== 'control' || typeof link.url !== 'string') {
      throw new OmpIdentityError('OMP host changed while resolving its capability', `OMP registry ${deps.config.dataDir}`);
    }
    const parsed = parseCollabLink(link.url);
    if ('error' in parsed || !parsed.writeToken) throw new OmpProtocolError('Resolve OMP host', `dataDir ${deps.config.dataDir}`, 'OMP host returned an invalid control capability');
    const matches = (await list(deadline)).filter(candidate => candidate.instanceId === host.instanceId || candidate.sessionId === host.sessionId);
    if (matches.length > 1) throw new OmpProtocolError('Resolve OMP host', `dataDir ${deps.config.dataDir}`, 'More than one host is serving the OMP session');
    const current = matches[0];
    if (!current || current.instanceId !== host.instanceId || current.sessionId !== host.sessionId ||
        current.generation !== host.generation || current.pid !== host.pid || current.cwd !== host.cwd) {
      throw new OmpIdentityError('OMP host session changed while resolving its capability', `OMP registry ${deps.config.dataDir}`);
    }
    return { instanceId: host.instanceId, sessionId: host.sessionId, generation: host.generation, url: link.url };
  }

  async function attach(instanceId: string, instancePath: string): Promise<HostBinding> {
    deps.assertActive();
    if (deps.closed) throw new OmpRuntimeStoppingError();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new OmpConfigurationError('Invalid OMP instance identifier', `OMP registry ${deps.config.dataDir}`);
    await deps.acquire();
    if (deps.closed) throw new OmpRuntimeStoppingError();
    const deadline = Date.now() + deps.config.omp.startupTimeoutMs;
    const host = (await list(deadline)).find(candidate => candidate.instanceId === instanceId);
    if (!host) throw new OmpSessionUnavailableError('OMP host is not available', `OMP registry ${deps.config.dataDir}`);
    if (await realpath(instancePath) !== instancePath || await realpath(host.cwd) !== instancePath) throw new OmpIdentityError('Attached host does not belong to this instance path', `OMP registry ${deps.config.dataDir}`);
    const binding = await resolve(host, deadline);
    if (deps.closed) throw new OmpRuntimeStoppingError();
    deps.assertActive();
    return binding;
  }

  return { list, resolve, attach };
}

