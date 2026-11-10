import { join } from 'node:path';
import { Bot } from 'grammy';
import { BotService } from '../../../src/bot.js';
import { readConfig } from '../../../src/config.js';
import { OmpRuntime } from '../../../src/runtime.js';
import { Store } from '../../../src/store.js';

function reportFailure(error: unknown): void {
  const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(diagnostic);
  if (process.connected && process.send) {
    process.send({ type: 'failure', diagnostic }, () => process.exit(1));
    setTimeout(() => process.exit(1), 1_000).unref();
  } else {
    process.exit(1);
  }
}

process.on('uncaughtException', reportFailure);
process.on('unhandledRejection', reportFailure);

async function main(): Promise<void> {
  const [configPath, emojis] = process.argv.slice(2);
  if (!configPath || !emojis || !process.send) throw new Error('Application worker requires config, topic emojis, and IPC');
  const config = readConfig(configPath);
  const botConfig = config.bots[0];
  if (!botConfig) throw new Error('Application worker requires a configured bot');
  const topicActivityEmojis = JSON.parse(emojis) as { running: string; finished: string };
  const store = new Store(join(config.dataDir, 'telegram.sqlite'));
  const runtime = new OmpRuntime(config);
  const nativeFork = runtime.fork.bind(runtime);
  runtime.fork = async (source, destination, target, beforeMutation) => {
    let mutations = 0;
    const context = { sourceId: source.id, destinationId: destination.id };
    process.send!({ type: 'forkProgress', ...context, stage: 'started' });
    try {
      await nativeFork(source, destination, target, async () => {
        const mutation = ++mutations;
        process.send!({ type: 'forkProgress', ...context, stage: 'authorizing', mutation });
        await beforeMutation?.();
        process.send!({ type: 'forkProgress', ...context, stage: 'authorized', mutation });
        if (mutation === 2) {
          process.send!({ type: 'forkPrepared', ...context });
          await new Promise<never>(() => undefined);
        }
      });
      throw new Error('Native fork completed without reaching the interruption barrier');
    } catch (error) {
      // BotService owns command errors and may deliver them to Telegram without
      // rejecting polling. Forward the original failure before that boundary,
      // otherwise the parent only sees an unrelated preparation timeout.
      const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(diagnostic);
      process.send!({ type: 'failure', ...context, mutation: mutations, diagnostic });
      throw error;
    }
  };
  const bot = new Bot(botConfig.token, { client: { environment: 'test' } });
  const service = new BotService({ config, botConfig, token: botConfig.token, store, runtime, bot, topicActivityEmojis });
  await service.start(() => {
    service.startBackground();
    process.send!({ type: 'ready' });
  });
  throw new Error('Application worker polling ended unexpectedly');
}

void main().catch(reportFailure);
