import { stdout, stderr } from 'node:process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { watchFile, unwatchFile, existsSync } from 'node:fs';
import { chmod, unlink, readFile, writeFile } from 'node:fs/promises';
import { createServer as createControlServer, type Server } from 'node:http';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { readConfig, defaultConfigPath, validateStart, findInstance } from './config.js';
import type { AppConfig } from '../shared/contracts.js';
import { Store } from './store.js';
import { createBot, type BotService } from './bot.js';
import { createServer, type GatewayServer } from './server.js';
import { OmpRuntime } from './runtime.js';
import { runAdmin, notifyReload } from './cli-admin.js';
import { sendTo } from './telegram-destination.js';

async function notifyGroups(config: AppConfig, bots: BotService[], store: Store, text: string): Promise<void> {
  await Promise.allSettled(bots.map(async bot => {
    await Promise.allSettled(store.listGroups(bot.id).filter(chat => findInstance(config, bot.id, chat)).map(async chatId => {
      const controller = new TelegramAbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await sendTo(bot.bot.telegram, {kind:'general',chatId}, text, undefined, {signal:controller.signal});
      } finally { clearTimeout(timeout); }
    }));
  }));
}

interface Generation {
  config: AppConfig;
  store: Store;
  runtime: OmpRuntime;
  bots: BotService[];
  close(): Promise<void>;
}

async function launch(config: AppConfig, onPollingFailure: () => void): Promise<Generation> {
  const startupAt = Date.now();
  const restartMarker = join(config.dataDir, 'restart-started-at');
  validateStart(config);
  const runtime = new OmpRuntime(config);
  let store: Store | undefined;
  const bots: BotService[] = [];
  let server: GatewayServer | undefined;
  let closePromise: Promise<void> | undefined;
  let started = false;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (started && store) {
        await writeFile(restartMarker, String(Date.now()), { mode: 0o600 });
        await notifyGroups(config, bots, store, 'OMP bot service is winding down. Sessions will be unavailable until it is back online.');
      }
      if (server) {
        await server.closeConnections();
        if (server.listening) {
          const closed = Promise.withResolvers<void>();
          server.close(error => error ? closed.reject(error) : closed.resolve());
          await closed.promise;
        }
      }
      await Promise.allSettled(bots.map(bot => bot.close()));
      await runtime.close();
      store?.close();
    })();
    return closePromise;
  };
  try {
    await runtime.acquire();
    store = new Store(join(config.dataDir, 'telegram.sqlite'));
    await runtime.validateSessionPaths(store.listSessions());
    for (const botConfig of config.bots) {
      const bot = createBot({ config, botConfig, token: botConfig.token, store, runtime });
      bots.push(bot);
      await bot.initialize();
      if (bot.id !== botConfig.id) throw new Error(`Telegram bot identity does not match configured bot ${botConfig.id}`);
      stdout.write(`Verified @${bot.bot.botInfo!.username} (bot ${bot.id}). Set the BotFather Mini App web URL to ${new URL(`/?bot=${bot.id}`, config.publicUrl).href}\n`);
    }
    if (config.terminated) await Promise.all(bots.map(bot => bot.applyTermination()));
    server = createServer({ config, bots, store, runtime });
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(config.port, config.host, () => {
      server!.off('error', listening.reject);
      listening.resolve();
    });
    await listening.promise;
    await Promise.all(bots.map(bot => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      void bot.start(resolve).then(() => {
        if (!started) reject(new Error('Telegram polling stopped during startup'));
      }, error => {
        if (!started) { reject(error); return; }
        stderr.write('Telegram polling stopped. Check bot credentials, network access, and that no other poller is running.\n');
        process.exitCode = 1;
        onPollingFailure();
      });
      return promise;
    }));
    started = true;
    const restartAt = await readFile(restartMarker, 'utf8').then(Number).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return startupAt;
    });
    await notifyGroups(config, bots, store, `OMP bot service is back online (restarting took ${((Date.now() - restartAt) / 1000).toFixed(2)} seconds).`);
    await unlink(restartMarker).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    stdout.write(`OMP Telegram listening on ${config.host}:${config.port}. Configuration: ${config.configPath}\n`);
    return { config, store, runtime, bots, close };
  } catch (error) {
    await close();
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
  let generation = await launch(readConfig(configPath), pollingFailure.resolve);
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
          generation = await launch(previous, pollingFailure.resolve);
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
  catch (error) { await generation.close(); throw error; }
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
  void pollingFailure.promise.then(() => service.close()).catch(error => stderr.write(`Service shutdown failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`));
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
  const shutdown = () => { void service.close().catch(error => { stderr.write(`${error instanceof Error ? error.message : 'Shutdown failed'}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
    process.exitCode = 1;
  });
}
