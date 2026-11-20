import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { procIdentity } from '../../../src/runtime/process.js';

export async function interruptManagedRelay(dataDir: string): Promise<void> {
  const descriptor = JSON.parse(await readFile(join(dataDir, 'local-relay', 'descriptor.json'), 'utf8')) as { pid: number; url: string };
  const args = (await readFile(`/proc/${descriptor.pid}/cmdline`, 'utf8')).split('\0');
  assert.ok(args.some(arg => /relay-daemon\.(?:ts|js)$/.test(arg)), 'Only the disposable relay daemon may be interrupted');
  assert.ok(args.includes(dataDir) || args.includes(join(dataDir, 'local-relay')), 'Relay process must belong to this fixture');
  process.kill(descriptor.pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  for (;;) {
    const identity = await procIdentity(descriptor.pid);
    if (!identity || identity.state === 'Z' || identity.state === 'X') return;
    if (Date.now() >= deadline) throw new Error('Disposable relay did not exit after SIGKILL');
    await delay(20);
  }
}
