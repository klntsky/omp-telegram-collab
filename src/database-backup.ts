import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// A separate reader lets the upgrader keep its writer lock while SQLite copies
// committed WAL data. FULL synchronous mode makes VACUUM INTO sync the backup.
// https://www.sqlite.org/lang_vacuum.html
export function backupDatabase(db: DatabaseSync): string | undefined {
  const source = db.location('main');
  if (!source) return undefined;
  const directory = mkdtempSync(join(dirname(source), `${basename(source)}.backup-`));
  const destination = join(directory, 'database.sqlite');
  closeSync(openSync(destination, 'wx', 0o600));
  const reader = new DatabaseSync(source, { readOnly: true });
  let failed = false;
  let failure: unknown;
  try {
    reader.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    reader.prepare('VACUUM main INTO ?').run(destination);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      reader.close();
    } catch (error) {
      if (!failed) throw error;
      throw new AggregateError([failure, error],
        `${failure instanceof Error ? failure.message : String(failure)}\nClosing database backup reader failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: failure });
    }
  }
  return destination;
}
