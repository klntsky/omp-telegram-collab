import type { DatabaseSync } from 'node:sqlite';
import { baselineSchema } from './database-schema.js';
import { databaseMigrations } from './database-migrations.js';
import { backupDatabase } from './database-backup.js';

export const databaseVersion = 10;

function validateVersion(db: DatabaseSync, version: number): void {
  if (version !== 0 && (version < 9 || version > databaseVersion)) {
    throw new Error(`Unsupported database schema version ${version}`);
  }
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
    throw new Error('Unsupported existing database');
  }
}

export function initializeDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout=5000');
  const initialVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  validateVersion(db, initialVersion);
  if (initialVersion === databaseVersion) return;
  // Keep backup creation and the version change under one writer lock so another
  // startup cannot change the database between its backup and upgrade.
  // https://www.sqlite.org/lang_transaction.html
  db.exec('BEGIN IMMEDIATE');
  try {
    let version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    validateVersion(db, version);
    if (version === databaseVersion) {
      db.exec('COMMIT');
      return;
    }
    if (version === 0) {
      db.exec(baselineSchema);
      db.exec('PRAGMA user_version=9');
      version = 9;
    } else {
      backupDatabase(db);
    }
    for (const migration of databaseMigrations) {
      if (migration.from !== version) continue;
      migration.apply(db);
      db.exec(`PRAGMA user_version=${migration.to}`);
      version = migration.to;
    }
    if (version !== databaseVersion) throw new Error(`Missing database migration from version ${version}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `${error instanceof Error ? error.message : String(error)}\nDatabase migration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error });
    }
    throw error;
  }
}
