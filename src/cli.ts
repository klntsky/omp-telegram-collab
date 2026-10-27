import { stdout, stderr } from 'node:process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, getBotToken } from './config.js';
import { Store } from './store.js';
import { createBot, type BotService } from './bot.js';
import { createServer, type GatewayServer } from './server.js';
import { OmpRuntime } from './runtime.js';


export async function startService(): Promise<{ close(): Promise<void> }> {
  const config = loadConfig();
  const store = new Store(join(config.dataDir,'telegram.sqlite'));
  const runtime = new OmpRuntime(config);
  const bots: BotService[] = [];
  let server: GatewayServer | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (server) {
        await server.closeConnections();
        if (server.listening) await new Promise<void>((resolve,reject) => server!.close(error => error ? reject(error) : resolve()));
      }
      await Promise.allSettled(bots.map(bot => bot.close()));
      await runtime.close();
      store.close();
    })();
    return closePromise;
  };
  try {
    for (const botConfig of config.bots) {
      const bot = createBot({config,botConfig,token:getBotToken(botConfig),store,runtime});
      bots.push(bot);
      await bot.initialize();
      stdout.write(`Verified @${bot.bot.botInfo!.username} (bot ${bot.id}). Set the BotFather Mini App web URL to ${new URL(`/?bot=${bot.id}`,config.publicUrl).href}\n`);
    }
    if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw new Error('The same Telegram bot was configured more than once');
    server = createServer({config,bots,store,runtime});
    await new Promise<void>((resolve,reject) => {
      server!.once('error',reject);
      server!.listen(config.port,config.host,() => {
        server!.off('error',reject);
        resolve();
      });
    });
    for (const bot of bots) {
      void bot.start().catch(() => {
        if (closePromise) return;
        stderr.write('Telegram polling stopped. Check bot credentials, network access, and that no other poller is running.\n');
        void close().finally(() => { process.exitCode = 1; });
      });
    }
    stdout.write(`OMP Telegram listening on ${config.host}:${config.port}. Public Mini App origin: ${config.publicUrl}\n`);
    return {close};
  } catch (error) {
    await close();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = argv.filter(value => value !== '--');
  const command = args.shift() ?? 'start';
  if ((command === '--help' || command === 'help') && args.length === 0) {
    stdout.write('Usage: omp-telegram [start|help|--help]\nConfigure TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_USERNAMES (comma-separated usernames), and PUBLIC_URL (HTTPS origin) in the environment before starting.\nThe package dev/start commands also load an optional .env file; exported environment variables take precedence. See .env.example for optional and named-bot settings.\n');
    return;
  }
  if (command !== 'start' || args.length !== 0) throw new Error('Usage: omp-telegram [start|help|--help]. Configure the service with environment variables; see .env.example.');
  const service = await startService();
  const shutdown = () => { void service.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    stderr.write(`${error instanceof ConfigError || (error instanceof Error && error.message.startsWith('Usage:')) ? error.message : 'Startup failed. Check the configured bot environment variables, network access, and local OMP installation.'}\n`);
    process.exitCode = 1;
  });
}
