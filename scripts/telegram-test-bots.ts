import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { logEvent } from '../src/logging.js';
import { resolveTelegramTestEnvFile } from '../test/e2e/helpers/telegram-env.js';
import { createTelegramTestBot, saveTelegramTestBot } from './lib/telegram-test-bot-provision.js';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
  process.stdout.write(String('Usage: pnpm telegram:test:bots add|create\nadd: read a token from hidden terminal input or piped stdin\ncreate: explicitly create one test-network bot through BotFather') + '\n');
} else if (args.length !== 1 || !['add', 'create'].includes(args[0]!)) {
  console.error('Usage: pnpm telegram:test:bots add|create (tokens are never accepted as arguments)');
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const signal = controller.signal;
  const interrupt = () => controller.abort(new Error('Telegram test bot provisioning interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const filename = await resolveTelegramTestEnvFile();
    let id: string;
    if (args[0] === 'create') {
      id = await createTelegramTestBot(filename, signal);
    } else {
      let token: string;
      if (process.stdin.isTTY) {
        const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        const input = createInterface({ input: process.stdin, output, terminal: true });
        input.on('SIGINT', interrupt);
        process.stderr.write('Test bot token (hidden): ');
        try { token = (await input.question('', { signal })).trim(); }
        finally { input.close(); output.end(); process.stderr.write('\n'); }
      } else {
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        const abort = () => input.close();
        signal.addEventListener('abort', abort, { once: true });
        const lines: string[] = [];
        try {
          signal.throwIfAborted();
          for await (const line of input) lines.push(line);
          signal.throwIfAborted();
          token = lines.join('\n').trim();
        } finally { input.close(); signal.removeEventListener('abort', abort); }
      }
      id = await saveTelegramTestBot(filename, token, signal);
    }
    process.stdout.write(String(`Saved bot ${id} in ${filename}`) + '\n');
  } catch (error) {
    logEvent('error', 'telegram.test.bot.provision.failed', { error });
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
