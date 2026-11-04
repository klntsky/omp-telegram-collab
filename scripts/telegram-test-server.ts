import { mkdir, chmod, lstat, unlink, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { TelegramClient, type BaseTelegramClient } from '@mtcute/node';
import { Api } from 'grammy';
import { telegramTestPaths } from './lib/telegram-test-client.js';
import { readTelegramTestCredentials } from './lib/telegram-test-auth.js';
import { TelegramTokenPool } from './lib/telegram-test-pool.js';
import { TelegramSessionService } from './lib/telegram-test-service.js';
import { createCentralTestBot } from './lib/telegram-test-botfather.js';
import { createCentralTelegramTestClient } from './lib/telegram-test-central-client.js';
process.umask(0o077);

const { directory, socket } = telegramTestPaths();
await mkdir(directory, { recursive: true, mode: 0o700 });
const info = await lstat(directory);
if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error('Session data directory must be owned by the current uid');
await chmod(directory, 0o700);
const socketDirectory = await lstat(dirname(socket));
if (!socketDirectory.isDirectory() || socketDirectory.uid !== process.getuid?.() || (socketDirectory.mode & 0o077) !== 0) {
  throw new Error('Session socket parent must be a private directory owned by the current uid');
}
const lockPath = `${socket}.owner.pid`;
async function lock() {
  try { return await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid session owner lock; manual recovery required');
    try { process.kill(pid, 0); }
    catch (probe) {
      if (!(probe instanceof Error && 'code' in probe && probe.code === 'ESRCH')) throw probe;
      await unlink(lockPath);
      return open(lockPath, 'wx', 0o600);
    }
    throw new Error('Telegram test session server already owns this data directory');
  }
}
const owner = await lock();
await owner.writeFile(String(process.pid));
let pool: TelegramTokenPool | undefined;
let base: BaseTelegramClient | undefined;
let service: TelegramSessionService | undefined;
let shutdown: Promise<void> | undefined;
const stopping = new AbortController();
const close = () => shutdown ??= (async () => {
  const errors: unknown[] = [];
  stopping.abort(new Error('Telegram test server shutting down'));
  const ownerStopped = base?.destroy().catch(error => { errors.push(error); });
  try { if (service) await service.close(socket); else if (pool) await pool.close(); } catch (error) { errors.push(error); }
  await ownerStopped;
  try { await owner.close(); } catch (error) { errors.push(error); }
  try { await unlink(lockPath); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Telegram test server shutdown failed');
})();
try {
  if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== 'recover')) throw new Error('Usage: telegram-test-server.ts [recover]');
  pool = new TelegramTokenPool(join(directory, 'bots.sqlite'));
  if (process.argv[2] === 'recover') {
    const token = process.env.TELEGRAM_TEST_RECOVER_TOKEN;
    if (!token) throw new Error('Set TELEGRAM_TEST_RECOVER_TOKEN after stopping all old bot pollers');
    pool.recover(token);
    console.log('Quarantined Telegram test bot recovered');
    await close();
  } else {
    const credentials = readTelegramTestCredentials();
    base = createCentralTelegramTestClient(credentials);
    await base.importSession(credentials.session);
    const client = new TelegramClient({ client: base, skipConversationUpdates: false });
    const config = await client.call({ _: 'help.getConfig' });
    if (!config.testMode) throw new Error('Refusing non-test Telegram network');
    const me = await client.getMe();
    if (me.isBot) throw new Error('Central Telegram session must be a user');
    await client.notifyLoggedIn(me.raw);
    const seed = process.env.TELEGRAM_TEST_BOT_TOKEN;
    if (seed) { await new Api(seed, { environment: 'test', timeoutSeconds: 30 }).getMe(); pool.seed(seed); }
    try {
      const old = await lstat(socket);
      if (!old.isSocket() || old.uid !== process.getuid?.()) throw new Error('Refusing to remove unsafe session socket path');
      const probe = connect(socket);
      try {
        await once(probe, 'connect');
        throw new Error('Refusing to replace a live session socket');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED')) throw error;
      } finally { probe.destroy(); }
      await unlink(socket);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    service = new TelegramSessionService({ client: base, onLastDisconnected: 'nothing' }, pool, () => createCentralTestBot(client, stopping.signal));
    await service.listen(socket);
    console.log('Telegram test session server ready');
    process.send?.('ready');
    const stop = () => { void close().catch(error => { console.error('Telegram test server shutdown failed', error); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
} catch (error) {
  try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Telegram test server startup and cleanup failed'); }
  throw error;
}
