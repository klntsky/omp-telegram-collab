import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function acquireTelegramTestLock(name: string, signal: AbortSignal, nonblocking = false): Promise<(() => Promise<void>) | undefined> {
  signal.throwIfAborted();
  const root = join(homedir(), '.local/state/omp-telegram-test');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error('Unsafe Telegram test lock directory');
  await chmod(root, 0o700);
  const file = await open(join(root, `${createHash('sha256').update(name).digest('hex')}.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Unsafe Telegram test lock file');
    await file.chmod(0o600);
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    const child = spawn('flock', ['--exclusive', ...(nonblocking ? ['--nonblock', '--conflict-exit-code', '75'] : []), '3'], { stdio: ['ignore', 'ignore', 'inherit', file.fd] });
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', reject);
    child.once('close', code => { signal.removeEventListener('abort', abort); resolve(code); });
    const code = await promise;
    signal.throwIfAborted();
    if (code === 75 && nonblocking) { await file.close(); return undefined; }
    if (code !== 0) throw new Error(`flock failed with exit code ${code}`);
    let closed = false;
    return async () => { if (!closed) { closed = true; await file.close(); } };
  } catch (error) {
    try { await file.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Telegram lock acquisition and cleanup failed'); }
    throw error;
  }
}

export async function withTelegramTestLock<T>(name: string, signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
  const release = await acquireTelegramTestLock(name, signal);
  let failure: unknown;
  try { return await callback(); } catch (error) { failure = error; throw error; } finally {
    try { await release!(); } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'Telegram operation and lock release failed');
      throw error;
    }
  }
}
