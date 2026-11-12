import { stdout, stderr } from 'node:process';
import { join } from 'node:path';
import { writeFileSync, writeSync } from 'node:fs';
import { unlink, readFile, writeFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { validateStart, findInstance } from '../config.js';
import type { AppConfig } from '../../shared/contracts.js';
import { Store } from '../store.js';
import { BotService } from '../bot.js';
import { createServer, type GatewayServer } from '../server.js';
import { OmpRuntime } from '../runtime.js';

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
        await bot.sendStatusNotice(chatId, text, controller.signal);
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

export async function launch(config: AppConfig, onPollingFailure: () => void, initialLaunch = false): Promise<Generation> {
  validateStart(config);
  const startupAt = Date.now();
  const launchAt = performance.now();
  if (initialLaunch) stdout.write(`Service timing process-start-to-launch bootstrap/dependencies/config: ${launchAt.toFixed(1)} ms\n`);
  const restartMarker = join(config.dataDir, 'restart-timing.json');
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
    const sessions = store.listSessions();
    await runtime.validateSessionPaths(sessions);
    for (const session of sessions) store.setSessionCwd(session.id, session.cwd);
    timing('session validation', phaseAt);
    for (const botConfig of config.bots) {
      const bot = new BotService({ config, botConfig, token: botConfig.token, store, runtime });
      bots.push(bot);
      phaseAt = performance.now();
      await bot.initialize();
      timing(`bot ${bot.id} initialization`, phaseAt);
      if (bot.id !== botConfig.id) throw new Error(`Telegram bot identity does not match configured bot ${botConfig.id}`);
      stdout.write(`Verified @${bot.bot.botInfo!.username} (bot ${bot.id}).${config.publicUrl ? ` Set the BotFather Mini App web URL to ${new URL(`/?bot=${bot.id}`, config.publicUrl).href}` : ' Telegram-only mode.'}\n`);
    }
    if (config.terminated) await Promise.all(bots.map(bot => bot.applyTermination()));
    if (config.publicUrl) {
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
    }
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
    stdout.write(`OMP Telegram ${config.publicUrl ? `listening on ${config.host}:${config.port}` : 'running in Telegram-only mode'}. Configuration: ${config.configPath}\n`);
    return { config, store, runtime, bots, close };
  } catch (error) {
    await close().catch(cleanupError => console.error('Startup cleanup failed:', cleanupError));
    throw error;
  }
}
