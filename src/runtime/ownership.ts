import { chmod, lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../../shared/contracts.js';
import { type HostLifecycle } from './types.js';
import { errno, RETIREMENT_GRANT } from './values.js';
interface OwnershipDependencies {
  readonly closed: boolean;
  readonly config: AppConfig;
}

// This owner keeps the complete ownership transaction and its cleanup together.
export interface RuntimeOwnership {
  acquire(): Promise<void>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  settleAcquisition(): Promise<void>;
  close(): void;
}

export function createOwnership(deps: OwnershipDependencies): RuntimeOwnership {
  let acquiring: Promise<void> | undefined;
  let lock: DatabaseSync | undefined;
  function acquire(): Promise<void> {
    if (acquiring) return acquiring;
    acquiring = (async () => {
      if (deps.closed) throw new Error('OMP runtime is stopping');
      await mkdir(deps.config.dataDir, { recursive: true, mode: 0o700 });
      const file = path.resolve(deps.config.dataDir, 'runtime-lock.sqlite');
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(file);
        database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL); DELETE FROM owner;');
        database.prepare('INSERT INTO owner (pid) VALUES (?)').run(process.pid);
        await chmod(file, 0o600);
        await revokeRetirementGrants();
        if (deps.closed) throw new Error('OMP runtime is stopping');
        lock = database;
      } catch (error) {
        database?.close();
        throw new Error(`Cannot acquire exclusive OMP runtime ownership for dataDir: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    })();
    return acquiring;
  }

  async function revokeRetirementGrants(): Promise<void> {
    const root = path.join(deps.config.dataDir, 'sessions');
    let entries;
    try {
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Managed session root is invalid');
      entries = await readdir(root, { withFileTypes: true });
    }
    catch (error) { if (errno(error, 'ENOENT')) return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())) continue;
      for (const filename of await readdir(directory)) {
        if (!RETIREMENT_GRANT.test(filename)) continue;
        const grant = path.join(directory, filename);
        try {
          const grantStat = await lstat(grant);
          if (!grantStat.isFile() || grantStat.isSymbolicLink() || (grantStat.mode & 0o077) !== 0 ||
              (process.getuid && grantStat.uid !== process.getuid())) continue;
          await unlink(grant);
        } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
      }
    }
  }

  async function lifecycle(id: string): Promise<HostLifecycle | undefined> {
    await acquire();
    try {
      const value = JSON.parse(await readFile(path.join(deps.config.dataDir,'sessions',id,'lifecycle.json'),'utf8')) as HostLifecycle;
      if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || typeof value.socketPath !== 'string' || typeof value.sessionId !== 'string') return undefined;
      return value;
    } catch (error) {
      if (errno(error,'ENOENT')) return undefined;
      throw error;
    }
  }
  async function settleAcquisition(): Promise<void> { await acquiring?.catch(() => undefined); }
  function close(): void { lock?.close(); lock = undefined; }
  return { acquire, lifecycle, settleAcquisition, close };
}

