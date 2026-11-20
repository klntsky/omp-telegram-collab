import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function acquireHostOwnership(directory) {
  const filename = join(directory, 'host-owner.sqlite');
  {
    await using file = await open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600);
  }
  const owner = new DatabaseSync(filename);
  try {
    // Both managed startup and offline RPC must exclude native history writers,
    // even before lifecycle/Collab publication. Keep the existing bounded wait
    // for the supervisor's PTY exit callback to release its ownership.
    owner.exec('PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL); DELETE FROM owner;');
    owner.prepare('INSERT INTO owner (pid) VALUES (?)').run(process.pid);
    return owner;
  } catch (error) {
    try { owner.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}\n${String(cleanup)}`); }
    throw error;
  }
}
