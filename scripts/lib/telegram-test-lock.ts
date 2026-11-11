import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { telegramTestTimeouts, withTelegramTestDeadline } from './telegram-test-deadline.js';
import { combineTelegramErrors } from '../../test/e2e/helpers/errors.js';

export async function acquireTelegramTestLock(name: string, signal: AbortSignal, nonblocking = false): Promise<(() => Promise<void>) | undefined> {
  if (nonblocking) return acquireLock(name, signal, true);
  const identity = /^bot:\d+$/.test(name) || name === 'authorization' || name === 'botfather'
    ? name
    : `sha256:${createHash('sha256').update(name).digest('hex')}`;
  return withTelegramTestDeadline(`Telegram test lock ${identity}`, telegramTestTimeouts.lease, signal, scope => acquireLock(name, scope, false));
}

async function acquireLock(name: string, signal: AbortSignal, nonblocking: boolean): Promise<(() => Promise<void>) | undefined> {
  signal.throwIfAborted();
  const root = join(homedir(), '.local/state/omp-telegram-test');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error('Unsafe Telegram test lock directory');
  await chmod(root, 0o700);
  const file = await open(join(root, `${createHash('sha256').update(name).digest('hex')}.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= file.close();
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Unsafe Telegram test lock file');
    await file.chmod(0o600);
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    const child = spawn('flock', ['--exclusive', ...(nonblocking ? ['--nonblock', '--conflict-exit-code', '75'] : []), '3'], { stdio: ['ignore', 'ignore', 'inherit', file.fd] });
    const abort = () => {
      child.kill('SIGKILL');
      void close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', reject);
    child.once('close', code => { signal.removeEventListener('abort', abort); resolve(code); });
    const code = await promise;
    signal.throwIfAborted();
    if (code === 75 && nonblocking) { await close(); return undefined; }
    if (code !== 0) throw new Error(`flock failed with exit code ${code}`);
    return close;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw combineTelegramErrors(error, cleanup); }
    throw error;
  }
}

export async function withTelegramTestLock<T>(name: string, signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
  const release = await acquireTelegramTestLock(name, signal);
  let failure: unknown;
  let failed = false;
  try { return await callback(); } catch (error) { failed = true; failure = error; throw error; } finally {
    try { await release!(); } catch (error) {
      if (failed) throw combineTelegramErrors(failure, error);
      throw error;
    }
  }
}
