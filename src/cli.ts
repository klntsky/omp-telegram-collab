import { stdout, stderr } from 'node:process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { watchFile, unwatchFile, existsSync, writeFileSync, writeSync } from 'node:fs';
import { chmod, unlink, readFile, writeFile } from 'node:fs/promises';
import { createServer as createControlServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { readConfig, defaultConfigPath, validateStart, findInstance } from './config.js';
import type { AppConfig } from '../shared/contracts.js';
import { Store } from './store.js';
import { createBot, type BotService } from './bot.js';
import { createServer, type GatewayServer } from './server.js';
import { OmpRuntime } from './runtime.js';
import { runAdmin, notifyReload } from './cli-admin.js';
import { sendTo } from './telegram-destination.js';

let pendingExitMarker: { path: string; startedAt: number } | undefined;
process.once('exit', () => {
  if (pendingExitMarker) {
    try { writeFileSync(pendingExitMarker.path, JSON.stringify({ startedAt: pendingExitMarker.startedAt, predecessorExitedAt: Date.now() }), { mode: 0o600 }); }
    catch (error) { writeSync(2, `Restart exit marker write failed: ${inspect(error)}\n`); }
  }
});

function timing(phase: string, since: number): void {
  stdout.write(`Service timing ${phase}: ${(performance.now() - since).toFixed(1)} ms\n`);
}

async function notifyGroups(config: AppConfig, bots: BotService[], store: Store, text: string, signal?: AbortSignal): Promise<void> {
  const botResults = await Promise.allSettled(bots.map(async bot => {
    const groupResults = await Promise.allSettled(store.listGroups(bot.id).filter(chat => findInstance(config, bot.id, chat)).map(async chatId => {
      if (signal?.aborted) return;
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 5000);
      try {
        await sendTo(bot.bot.api, {kind:'general',chatId}, text, undefined, controller.signal);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }));
    for (const result of groupResults) {
      if (result.status === 'rejected' && !signal?.aborted) console.error(`Lifecycle notification failed for bot ${bot.id}:`, result.reason);
    }
  }));
  for (const result of botResults) {
    if (result.status === 'rejected' && !signal?.aborted) console.error('Lifecycle notification failed:', result.reason);
  }
}

interface Generation {
  config: AppConfig;
  store: Store;
  runtime: OmpRuntime;
  bots: BotService[];
  close(): Promise<void>;
}

async function launch(config: AppConfig, onPollingFailure: () => void, initialLaunch = false): Promise<Generation> {
  const startupAt = Date.now();
  const launchAt = performance.now();
  if (initialLaunch) stdout.write(`Service timing process-start-to-launch bootstrap/dependencies/config: ${launchAt.toFixed(1)} ms\n`);
  const restartMarker = join(config.dataDir, 'restart-timing.json');
  validateStart(config);
  const runtime = new OmpRuntime(config);
  let store: Store | undefined;
  const bots: BotService[] = [];
  let server: GatewayServer | undefined;
  let closePromise: Promise<void> | undefined;
  let started = false;
  const onlineController = new AbortController();
  let onlineTask = Promise.resolve();
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const shutdownAt = performance.now();
      onlineController.abort();
      await onlineTask;
      let failure: unknown;
      let failed = false;
      const attempt = async (operation: () => Promise<void> | void) => {
        try { await operation(); }
        catch (error) {
          console.error('Service cleanup failed:', error);
          if (!failed) { failed = true; failure = error; }
        }
      };
      let notices = Promise.resolve();
      if (started && store) {
        const startedAt = Date.now();
        await attempt(async () => {
          await writeFile(restartMarker, JSON.stringify({ startedAt, predecessorExitedAt: null }), { mode: 0o600 });
          pendingExitMarker = { path: restartMarker, startedAt };
        });
        const noticeAt = performance.now();
        notices = notifyGroups(config, bots, store, 'OMP bot service is winding down. Sessions will be unavailable until it is back online.').finally(() => timing('shutdown notices', noticeAt));
      }
      const drainAt = performance.now();
      await attempt(async () => {
        if (server) {
          await server.closeConnections();
          if (server.listening) {
            const closed = Promise.withResolvers<void>();
            server.close(error => error ? closed.reject(error) : closed.resolve());
            await closed.promise;
          }
        }
      });
      await Promise.all(bots.map(bot => attempt(() => bot.close())));
      timing('shutdown drain', drainAt);
      const runtimeAt = performance.now();
      await attempt(() => runtime.close());
      timing('shutdown runtime', runtimeAt);
      await attempt(() => notices);
      const storeAt = performance.now();
      await attempt(() => store?.close());
      timing('shutdown store', storeAt);
      timing('shutdown total', shutdownAt);
      if (failed) throw failure;
    })();
    return closePromise;
  };
  try {
    let phaseAt = performance.now();
    await runtime.acquire();
    timing('runtime acquire', phaseAt);
    phaseAt = performance.now();
    store = new Store(join(config.dataDir, 'telegram.sqlite'));
    timing('store open', phaseAt);
    phaseAt = performance.now();
    await runtime.validateSessionPaths(store.listSessions());
    timing('session validation', phaseAt);
    for (const botConfig of config.bots) {
      const bot = createBot({ config, botConfig, token: botConfig.token, store, runtime });
      bots.push(bot);
      phaseAt = performance.now();
      await bot.initialize();
      timing(`bot ${bot.id} initialization`, phaseAt);
      if (bot.id !== botConfig.id) throw new Error(`Telegram bot identity does not match configured bot ${botConfig.id}`);
      stdout.write(`Verified @${bot.bot.botInfo!.username} (bot ${bot.id}). Set the BotFather Mini App web URL to ${new URL(`/?bot=${bot.id}`, config.publicUrl).href}\n`);
    }
    if (config.terminated) await Promise.all(bots.map(bot => bot.applyTermination()));
    server = createServer({ config, bots, store, runtime });
    phaseAt = performance.now();
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(config.port, config.host, () => {
      server!.off('error', listening.reject);
      listening.resolve();
    });
    await listening.promise;
    timing('HTTP bind', phaseAt);
    await Promise.all(bots.map(bot => {
      const pollAt = performance.now();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      void bot.start(() => { timing(`bot ${bot.id} first poll`, pollAt); resolve(); }).then(() => {
        if (!started) reject(new Error('Telegram polling stopped during startup'));
      }, error => {
        if (!started) { reject(error); return; }
        stderr.write('Telegram polling stopped. Check bot credentials, network access, and that no other poller is running.\n');
        console.error('Telegram polling failure:', error);
        process.exitCode = 1;
        onPollingFailure();
      });
      return promise;
    }));
    started = true;
    const readyAt = performance.now();
    timing('launch-to-first-poll-ready', launchAt);
    if (initialLaunch) timing('process-start-to-ready', 0);
    for (const bot of bots) bot.startBackground();
    onlineTask = (async () => {
      const marker = await readFile(restartMarker, 'utf8').then(text => JSON.parse(text) as { startedAt: number; predecessorExitedAt: number | null }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { startedAt: startupAt, predecessorExitedAt: null };
      });
      if (onlineController.signal.aborted) return;
      if (initialLaunch && marker.predecessorExitedAt !== null) stdout.write(`Service timing process replacement gap: ${(performance.timeOrigin - marker.predecessorExitedAt).toFixed(1)} ms\n`);
      await unlink(restartMarker).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      pendingExitMarker = undefined;
      if (onlineController.signal.aborted) return;
      await notifyGroups(config, bots, store!, `OMP bot service is back online (restarting took ${((Date.now() - marker.startedAt) / 1000).toFixed(2)} seconds).`, onlineController.signal);
    })().catch(error => console.error('Online notification failed:', error)).finally(() => timing('ready-to-notification', readyAt));
    stdout.write(`OMP Telegram listening on ${config.host}:${config.port}. Configuration: ${config.configPath}\n`);
    return { config, store, runtime, bots, close };
  } catch (error) {
    await close().catch(cleanupError => console.error('Startup cleanup failed:', cleanupError));
    throw error;
  }
}

function serviceSettings(config: AppConfig): string {
  const { maxSessions: _, ...omp } = config.omp;
  return JSON.stringify({ bots: config.bots.map(({ admins: _, ...bot }) => bot), publicUrl: config.publicUrl, host: config.host, port: config.port, dataDir: config.dataDir, omp });
}

export async function startService(configPath = defaultConfigPath()): Promise<{ close(): Promise<void>; reload(): Promise<void> }> {
  configPath = resolve(configPath);
  const pollingFailure = Promise.withResolvers<void>();
  let generation = await launch(readConfig(configPath), pollingFailure.resolve, true);
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let reloadTail = Promise.resolve();
  const controls = new Map<string, Server>();
  let applied = JSON.stringify(generation.config);

  const reload = (): Promise<void> => {
    const operation = reloadTail.then(async () => {
      if (closing) throw new Error('Service is stopping');
      const next = readConfig(configPath);
      validateStart(next);
      if (JSON.stringify(next) === applied) return;
      await generation.runtime.validateSessionPaths(generation.store.listSessions(), next);
      if (serviceSettings(next) === serviceSettings(generation.config)) {
        if (next.terminated === undefined) delete generation.config.terminated;
        Object.assign(generation.config, next);
        generation.runtime.setSessionLimit(next.omp.maxSessions);
        if (generation.config.terminated) await Promise.all(generation.bots.map(bot => bot.applyTermination()));
        await Promise.all(generation.bots.map(bot => bot.reconcileConfiguration()));
      } else {
        const previous = generation.config;
        await generation.close();
        try { generation = await launch(next, pollingFailure.resolve); }
        catch (error) {
          try { generation = await launch(previous, pollingFailure.resolve); }
          catch (rollbackError) { console.error('Configuration rollback failed:', rollbackError); }
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
    reloadTail = operation.catch(() => undefined);
    return operation;
  };

  async function bindControl(dataDir: string): Promise<void> {
    const socket = join(dataDir, 'control.sock');
    if (controls.has(socket)) return;
    await unlink(socket).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    const control = createControlServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/reload') throw new Error('Use POST /reload');
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) throw new Error('Request too large');
        }
        if (JSON.parse(body).configPath !== configPath) throw new Error(`Running service uses a different configuration: ${configPath}`);
        await reload();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      })().catch(error => {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Configuration reload failed' }));
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

  const changed = () => { void reload().catch(error => stderr.write(`Configuration not applied: ${error instanceof Error ? error.message : 'Reload failed'}\n`)); };
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

const usage = `Usage: omp-telegram [--config PATH] <start|setup|configure|reload|create|list|show|remove|admin|chat|approve|bot>
Instances are identified by directory paths. Run setup for guided configuration.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = argv.filter(value => value !== '--');
  let configPath = defaultConfigPath();
  let explicitConfig = false;
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument !== '--config' && !argument.startsWith('--config=')) { index++; continue; }
    if (explicitConfig) throw new Error('Specify --config only once');
    explicitConfig = true;
    const value = argument === '--config' ? args[index + 1] : argument.slice('--config='.length);
    if (!value || value.startsWith('--')) throw new Error('--config requires a path');
    configPath = resolve(value);
    args.splice(index, argument === '--config' ? 2 : 1);
  }
  if (args.length === 1 && ['--help', 'help', '-h'].includes(args[0]!)) { stdout.write(usage); return; }
  if (args[0] === 'reload' && args.length === 1) {
    await notifyReload(readConfig(configPath));
    stdout.write(`Reload requested for ${configPath}\n`);
    return;
  }
  if (args.length && args[0] !== 'start') {
    if (await runAdmin(args, configPath)) return;
    throw new Error(usage.trim());
  }
  if (args.length > 1) throw new Error(usage.trim());
  if (explicitConfig && !existsSync(configPath)) throw new Error(`Configuration does not exist: ${configPath}. Run omp-telegram --config ${JSON.stringify(configPath)} configure.`);
  const service = await startService(configPath);
  const shutdown = () => { void service.close().catch(error => { console.error('Shutdown failed:', error); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
    process.exitCode = 1;
  });
}
