import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../../shared/contracts.js';
import { withCancellation } from '../cancellation.js';
import { ompArguments } from './arguments.js';
import { privateFile } from './files.js';
import { record, errno } from './values.js';
interface SkillsDependencies {
  assertActive(): void;
  readonly closed: boolean;
  readonly config: AppConfig;
  readonly skillProcesses: Set<ChildProcess>;
}

// This owner keeps the complete skills transaction and its cleanup together.
export interface RuntimeSkills {
  cachedSkills(instancePath: string, signal?: AbortSignal): Promise<Array<{ name: string; description: string }>>;
  killSkillProcess(child: ChildProcess): void;
  closeDiscovery(): Promise<void>;
}

export function createSkills(deps: SkillsDependencies): RuntimeSkills {
  const skillCatalogs = new Map<string, {
    expiresAt: number;
    catalog?: Array<{ name: string; description: string }>;
    error?: unknown;
  }>();
  const skillDiscovery = new Map<string, {
    promise: Promise<Array<{ name: string; description: string }>>;
    controller: AbortController;
    consumers: number;
  }>();
  async function cachedSkills(instancePath: string, signal?: AbortSignal): Promise<Array<{ name: string; description: string }>> {
    signal?.throwIfAborted();
    deps.assertActive();
    if (deps.closed) throw new Error('OMP runtime is stopping');
    const cached = skillCatalogs.get(instancePath);
    if (cached && cached.expiresAt > Date.now()) {
      skillCatalogs.delete(instancePath);
      skillCatalogs.set(instancePath, cached);
      if (cached.catalog) return cached.catalog;
      throw cached.error;
    }
    let pending = skillDiscovery.get(instancePath);
    if (pending?.controller.signal.aborted) {
      const abandoned = pending;
      await abandoned.promise.catch(error => {
        if (error !== abandoned.controller.signal.reason) throw error;
      });
      return cachedSkills(instancePath, signal);
    }
    if (!pending) {
      const controller = new AbortController();
      const discovery = discoverSkills(instancePath, controller.signal).then(catalog => {
        if (catalog.some(value => !value.name)) throw new Error('OMP returned an invalid skill catalog');
        rememberSkills(instancePath, { catalog, expiresAt: Date.now() + 5 * 60_000 });
        return catalog;
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) rememberSkills(instancePath, { error, expiresAt: Date.now() + 30_000 });
        throw error;
      }).finally(() => {
        skillDiscovery.delete(instancePath);
      });
      pending = { promise: discovery, controller, consumers: 0 };
      skillDiscovery.set(instancePath, pending);
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

  function rememberSkills(instancePath: string, entry: {
    expiresAt: number;
    catalog?: Array<{ name: string; description: string }>;
    error?: unknown;
  }): void {
    if (deps.closed) return;
    skillCatalogs.delete(instancePath);
    skillCatalogs.set(instancePath, entry);
    while (skillCatalogs.size > 128) {
      skillCatalogs.delete(skillCatalogs.keys().next().value!);
    }
  }

  async function discoverSkills(instancePath: string, signal: AbortSignal): Promise<Array<{ name: string; description: string }>> {
    const args = ompArguments(deps.config.omp.args);
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
      deps.assertActive();
      if (deps.closed) throw new Error('OMP runtime is stopping');
      signal.throwIfAborted();
      child = spawn(deps.config.omp.executable, [
        ...deps.config.omp.args, '--cwd', instancePath, '--config', config,
        '--mode', 'rpc', '--no-session', '--no-title',
      ], { cwd: instancePath, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      deps.skillProcesses.add(child);
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
        const timer = setTimeout(() => finish(new Error('OMP skill discovery timed out')), deps.config.omp.startupTimeoutMs);
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
        killSkillProcess(child);
        await exited;
        deps.skillProcesses.delete(child);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }

  function killSkillProcess(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (!errno(error, 'ESRCH')) throw error;
    }
  }
  async function closeDiscovery(): Promise<void> {
    for (const discovery of skillDiscovery.values()) discovery.controller.abort(new Error('OMP runtime is stopping'));
    await Promise.allSettled([...skillDiscovery.values()].map(discovery => discovery.promise));
    skillCatalogs.clear();
  }
  return { cachedSkills, killSkillProcess, closeDiscovery };
}

