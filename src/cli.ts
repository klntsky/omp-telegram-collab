import { stdout } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { readConfig, defaultConfigPath } from './config.js';
import { registerAdminCommands } from './cli-admin.js';
import { notifyReload } from './cli/reload.js';
import { joinSession } from './session-cli.js';
import { startService } from './cli/service.js';
import { parseTopicUrl } from './cli/topic-url.js';
import { pollingFailureReported } from './cli/polling-failure.js';
import { logEvent } from './logging.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const program = new Command()
    .name('omp-telegram-collab')
    .description('Run local OMP coding sessions from Telegram forum topics.')
    .addHelpCommand(true)
    .option('--config <PATH>', 'Configuration file', (value: string, previous?: string) => {
      if (previous !== undefined) throw new InvalidArgumentError('Specify --config only once');
      return resolve(value);
    })
    .configureHelp({ showGlobalOptions: true })
    .configureOutput({ outputError: () => {} })
    .exitOverride();
  const configPath = () => program.opts<{ config?: string }>().config ?? defaultConfigPath();
  const closeAdmin = registerAdminCommands(program, configPath);
  const start = async () => {
    const path = configPath();
    if (program.getOptionValueSource('config') === 'cli' && !existsSync(path))
      throw new Error(`Configuration does not exist: ${path}. Run omp-telegram-collab --config ${JSON.stringify(path)} setup.`);
    const service = await startService(path);
    const shutdown = () => { void service.close().catch(error => { logEvent('error', 'shutdown-failed', { message: 'Shutdown failed:', error }); process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  };
  program.action(start);
  program.command('start').description('Start the bot').action(start);
  program.command('reload').description('Ask the running service to apply saved configuration.').action(async () => {
    const path = configPath();
    await notifyReload(readConfig(path));
    stdout.write(`Reload requested for ${path}\n`);
  });
  program.command('join <topic-url>').description('Continue a topic session in your terminal')
    .action(async (topicUrl: string) => {
      await joinSession(parseTopicUrl(topicUrl), configPath());
    });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError && error.exitCode === 0)) throw error;
  } finally {
    closeAdmin();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch(error => {
    if (!pollingFailureReported(error)) logEvent('error', 'command-failed', { message: 'Command failed', error });
    process.exitCode = 1;
  });
}
