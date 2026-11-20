import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DurableBinding, HostLifecycle, ManagedHost } from './types.js';
import { belongsTo, procIdentity } from './process.js';
import { errno } from './values.js';

// Collab publishes only after connecting to its relay; absence from that registry
// is not absence of our child. Verify the private lifecycle against the pinned
// history and actual process ancestry before authorizing offline retirement.
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/collab/host.ts
// CollabHost.start waits for firstOpen before publishCollabHost.
export async function managedLifecycleIdentity(dataDir: string, id: string, host: ManagedHost, lifecycle: HostLifecycle) {
  const identity = await procIdentity(lifecycle.pid);
  if (!identity || identity.state === 'Z' || identity.state === 'X') return undefined;
  const directory = path.join(dataDir, 'sessions', id);
  const pin = JSON.parse(await readFile(path.join(directory, 'binding.json'), 'utf8')) as DurableBinding;
  if (pin.sessionId !== host.sessionId || lifecycle.sessionId !== pin.sessionId ||
      (host.cwd !== undefined && host.cwd !== pin.cwd) ||
      (host.identity && (host.identity.pid !== lifecycle.pid || host.identity.start !== identity.start)) ||
      (host.process?.pid !== undefined && host.process.pid !== lifecycle.supervisorPid)) {
    throw new Error('Managed OMP lifecycle identity changed');
  }
  const supervisor = await procIdentity(lifecycle.supervisorPid);
  if (!supervisor || supervisor.state === 'Z' || supervisor.state === 'X' ||
      !await belongsTo(lifecycle.pid, lifecycle.supervisorPid)) throw new Error('Managed OMP supervisor identity changed');
  const args = (await readFile(`/proc/${lifecycle.pid}/cmdline`, 'utf8')).split('\0');
  // Native worktree relocation can move the current history after launch. The
  // private descriptor and binding carry its current identity; argv proves only
  // the original service-owned session directory, not the current resume path.
  if (!args.includes('--session-dir') || args[args.indexOf('--session-dir') + 1] !== directory ||
      await realpath(`/proc/${lifecycle.pid}/cwd`) !== pin.cwd) throw new Error('Managed OMP process does not match its pinned history');
  const socket = await lstat(lifecycle.socketPath);
  const descriptor = await lstat(path.join(directory, 'lifecycle.json'));
  if (!socket.isSocket() || descriptor.isSymbolicLink() || !descriptor.isFile() ||
      (socket.mode & 0o077) !== 0 || (descriptor.mode & 0o077) !== 0 ||
      (process.getuid && (socket.uid !== process.getuid() || descriptor.uid !== process.getuid()))) {
    throw new Error('Managed OMP lifecycle endpoint is not private');
  }
  const current = await procIdentity(lifecycle.pid);
  if (!current || current.start !== identity.start) throw new Error('Managed OMP process changed during lifecycle validation');
  return identity;
}

export async function usesManagedRelay(directory: string, relayUrl: string): Promise<boolean> {
  try {
    const overlay = JSON.parse(await readFile(path.join(directory, 'runtime.yml'), 'utf8'));
    return overlay?.collab?.autoStart === 'control' && overlay.collab.relayUrl === relayUrl;
  } catch (error) {
    if (errno(error, 'ENOENT')) return false;
    throw error;
  }
}
