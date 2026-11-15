import { stdout, stderr } from 'node:process';
import { resolve, join } from 'node:path';
import { watchFile, unwatchFile } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { createServer as createControlServer, type Server, type ServerResponse } from 'node:http';
import { readConfig, defaultConfigPath, validateStart, findInstance, ConfigError } from '../config.js';
import type { AppConfig } from '../../shared/contracts.js';
import { launch } from './generation.js';
import { pollingFailureReported } from './polling-failure.js';

function serviceSettings(config: AppConfig): string {
  const { maxSessions: _, ...omp } = config.omp;
  return JSON.stringify({ bots: config.bots, publicUrl: config.publicUrl, host: config.host, port: config.port, dataDir: config.dataDir, omp });
}

export async function startService(configPath = defaultConfigPath()): Promise<{ close(): Promise<void>; reload(): Promise<void> }> {
  configPath = resolve(configPath);
  class ServiceControlError extends Error {
    constructor(detail: string, cause?: unknown) {
      super(`Service control failed for ${configPath}: ${detail}`, { cause });
      this.name = 'ServiceControlError';
    }
  }
  const pollingFailure = Promise.withResolvers<void>();
  let generation = await launch(readConfig(configPath), pollingFailure.resolve, true);
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let reloadTail = Promise.resolve();
  const controls = new Map<string, Server>();
  const joins = new Set<ServerResponse>();
  let applied = JSON.stringify(generation.config);

  const reload = (): Promise<void> => {
    const operation = reloadTail.then(async () => {
      if (closing) throw new ServiceControlError('Service is stopping');
      const next = readConfig(configPath);
      validateStart(next);
      if (JSON.stringify(next) === applied) return;
      const sessions = generation.store.listSessions();
      await generation.runtime.validateSessionPaths(sessions, next);
      for (const session of sessions) generation.store.setSessionCwd(session.id, session.cwd);
      if (serviceSettings(next) === serviceSettings(generation.config)) {
        if (next.terminated === undefined) delete generation.config.terminated;
        Object.assign(generation.config, next);
        generation.runtime.setSessionLimit(next.omp.maxSessions);
        if (generation.config.terminated) await Promise.all(generation.bots.map(bot => bot.applyTermination()));
        await Promise.all(generation.bots.map(bot => bot.reconcileConfiguration()));
      } else {
        const previous = generation.config;
        for (const response of joins) response.destroy();
        await generation.close();
        try { generation = await launch(next, pollingFailure.resolve); }
        catch (error) {
          try { generation = await launch(previous, pollingFailure.resolve); }
          catch (rollbackError) { if (!pollingFailureReported(rollbackError)) console.error('Configuration rollback failed:', rollbackError); }
          throw error;
        }
        await bindControl(next.dataDir);
        for (const [socket, control] of controls) {
          if (socket === join(next.dataDir, 'control.sock')) continue;
          control.close();
          controls.delete(socket);
        }
      }
      applied = JSON.stringify(generation.config);
      stdout.write(`Applied configuration: ${configPath}\n`);
    });
    // The returned operation owns rejection; this tail only serializes later work.
    reloadTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  async function joinSession(chatId: unknown, topicId: unknown): Promise<{ result: { url: string; executable: string }; release(): void }> {
    if (!Number.isSafeInteger(chatId) || (chatId as number) >= 0) throw new ServiceControlError('chatId must be a negative safe integer');
    if (!Number.isSafeInteger(topicId) || (topicId as number) <= 1) throw new ServiceControlError('topicId must be a safe integer greater than 1');
    await reload();
    const operation = reloadTail.then(async () => {
      if (closing) throw new ServiceControlError('Service is stopping');
      const current = generation;
      const matches = current.store.listSessions().filter(session => session.chatId === chatId && session.threadId === topicId &&
        current.config.bots.some(bot => bot.id === session.botId) &&
        current.store.isEnrolled(session.botId, session.chatId) &&
        findInstance(current.config, session.botId, session.chatId)?.instance.id === session.instanceId);
      if (matches.length > 1) throw new ServiceControlError('Topic session is ambiguous across configured bots');
      const session = matches[0];
      if (!session) throw new ServiceControlError('No enrolled, assigned topic session found');
      const sessionGeneration = current.store.getSessionGeneration(session.id);
      const guard = async () => {
        if (closing || generation !== current) throw new ServiceControlError('Service is stopping or its generation changed');
        const persisted = readConfig(configPath);
        validateStart(persisted);
        if (current.config.terminated || persisted.terminated) throw new ServiceControlError('Service is terminated');
        if (JSON.stringify(persisted) !== applied) throw new ServiceControlError('Configuration changed during session join');
        const stored = current.store.getSession(session.id);
        if (!stored || stored.status !== 'open' || stored.botId !== session.botId ||
            stored.chatId !== session.chatId || stored.threadId !== session.threadId ||
            stored.instanceId !== session.instanceId || stored.cwd !== session.cwd ||
            current.store.getSessionGeneration(session.id) !== sessionGeneration) {
          throw new ServiceControlError('Topic session is not open or changed during session join');
        }
        if (!current.store.isEnrolled(session.botId, session.chatId) ||
            !current.config.bots.some(bot => bot.id === session.botId) ||
            findInstance(current.config, session.botId, session.chatId)?.instance.id !== session.instanceId ||
            findInstance(persisted, session.botId, session.chatId)?.instance.id !== session.instanceId) {
          throw new ServiceControlError('Topic session assignment changed');
        }
      };
      await guard();
      const binding = await current.runtime.ensure(session, guard);
      await guard();
      const release = current.runtime.retain(session.id);
      try {
        const bot = current.bots.find(bot => bot.id === session.botId);
        if (!bot) throw new ServiceControlError('Topic session bot is no longer configured');
        await bot.ensureMirroring(session, binding, guard);
        await guard();
        return { result: { url: binding.url, executable: current.config.omp.executable }, release };
      } catch (error) {
        release();
        throw error;
      }
    });
    // joinSession's caller owns rejection; the queue must remain usable afterward.
    reloadTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function bindControl(dataDir: string): Promise<void> {
    const socket = join(dataDir, 'control.sock');
    if (controls.has(socket)) return;
    await rm(socket, { force: true });
    const control = createControlServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || !['/reload', '/session/join'].includes(request.url ?? '')) throw new ServiceControlError('Use POST /reload');
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) throw new ServiceControlError('Request too large');
        }
        let payload: unknown;
        try { payload = JSON.parse(body); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new ServiceControlError(`Invalid control request JSON: ${error.message}`, error);
        }
        if (!payload || typeof payload !== 'object' || !('configPath' in payload)) throw new ServiceControlError('Control request must contain configPath');
        if (payload.configPath !== configPath) throw new ServiceControlError(`Running service uses a different configuration: ${configPath}`);
        if (request.url === '/session/join') {
          const { result, release } = await joinSession('chatId' in payload ? payload.chatId : undefined, 'topicId' in payload ? payload.topicId : undefined);
          if (response.destroyed) { release(); return; }
          joins.add(response);
          const releaseLease = () => {
            response.off('close', releaseLease);
            joins.delete(response);
            release();
          };
          response.once('close', releaseLease);
          try {
            response.writeHead(200, { 'content-type': 'application/x-ndjson' });
            response.write(`${JSON.stringify(result)}\n`);
          } catch (error) {
            releaseLease();
            throw error;
          }
        } else {
          await reload();
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        }
      })().catch(error => {
        if (error instanceof Error) error.message = `Service control ${request.method ?? 'UNKNOWN'} ${request.url ?? '/'} for ${configPath}: ${error.message}`;
        if (!pollingFailureReported(error)) console.error('Service control request failed.', error);
        response.writeHead(error instanceof ServiceControlError || error instanceof ConfigError ? 409 : 500, { 'content-type': 'application/json' });
        const detail = error as { code?: unknown; signal?: unknown } | null;
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          ...(typeof detail?.code === 'string' || typeof detail?.code === 'number' ? { code: detail.code } : {}),
          ...(typeof detail?.signal === 'string' ? { signal: detail.signal } : {}),
        }));
      });
    });
    control.requestTimeout = 15000;
    const listening = Promise.withResolvers<void>();
    control.once('error', listening.reject);
    control.listen(socket, () => { control.off('error', listening.reject); listening.resolve(); });
    await listening.promise;
    await chmod(socket, 0o600);
    controls.set(socket, control);
  }

  const changed = () => { void reload().catch(error => {
    if (!pollingFailureReported(error)) stderr.write(`Configuration not applied: ${error instanceof Error ? error.message : String(error)}\n`);
  }); };
  try { await bindControl(generation.config.dataDir); }
  catch (error) {
    await generation.close().catch(cleanupError => console.error('Startup cleanup failed:', cleanupError));
    throw error;
  }
  watchFile(configPath, { interval: 500, persistent: false }, changed);
  const service = {
    reload,
    close() {
      closePromise ??= (async () => {
        closing = true;
        unwatchFile(configPath, changed);
        await reloadTail;
        await Promise.all([...controls.values()].map(control => {
          const closed = Promise.withResolvers<void>();
          control.close(() => closed.resolve());
          control.closeAllConnections();
          return closed.promise;
        }));
        controls.clear();
        await generation.close();
      })();
      return closePromise;
    },
  };
  void pollingFailure.promise.then(() => service.close()).catch(error => console.error('Service shutdown failed:', error));
  return service;
}
