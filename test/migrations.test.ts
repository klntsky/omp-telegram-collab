import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateDatabase } from '../src/migrations.js';
import { Store } from '../src/store.js';

function version(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()!.user_version);
}

test('migrations apply in order, skip applied steps, and preserve data on upgrade', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const steps = [
      'CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
      "ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; UPDATE records SET revision=1;",
      'UPDATE records SET revision=revision+1;',
    ];
    migrateDatabase(db, steps.slice(0, 1));
    db.prepare('INSERT INTO records VALUES (?,?)').run(7, 'retained');
    migrateDatabase(db, steps);
    assert.equal(version(db), 3);
    assert.deepEqual({ ...db.prepare('SELECT * FROM records').get() }, { id: 7, value: 'retained', revision: 2 });
    migrateDatabase(db, steps);
    assert.equal(db.prepare('SELECT revision FROM records').get()!.revision, 2);
    assert.throws(() => migrateDatabase(db, steps.slice(0, 2)));
    assert.equal(version(db), 3);
    assert.equal(db.prepare('SELECT value FROM records').get()!.value, 'retained');
  } finally { db.close(); }
});

test('failed upgrades roll back schema, data, and version and retain the SQLite diagnostic', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const initial = 'CREATE TABLE records (value INTEGER NOT NULL); INSERT INTO records VALUES (1);';
    migrateDatabase(db, [initial]);
    const update = 'ALTER TABLE records ADD COLUMN revision INTEGER; UPDATE records SET value=2;';
    const invalid = 'INSERT INTO missing_table VALUES (1);';
    let original: unknown;
    try { db.exec(invalid); } catch (error) { original = error; }
    assert.throws(() => migrateDatabase(db, [initial, update, invalid]), (error: unknown) => {
      assert.ok(error instanceof Error && original instanceof Error);
      assert.equal(error.message, original.message);
      assert.equal((error as Error & { code?: string }).code, (original as Error & { code?: string }).code);
      return true;
    });
    assert.equal(version(db), 1);
    assert.deepEqual(db.prepare('PRAGMA table_info(records)').all().map(row => row.name), ['value']);
    assert.equal(db.prepare('SELECT value FROM records').get()!.value, 1);
    migrateDatabase(db, [initial, update]);
    assert.equal(version(db), 2);
    assert.equal(db.prepare('SELECT value FROM records').get()!.value, 2);
  } finally { db.close(); }
});

test('store initializes fresh storage and versions existing unversioned storage without losing enrollment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-migrations-'));
  const filename = join(directory, 'telegram.sqlite');
  try {
    const fresh = new Store(':memory:');
    try {
      assert.equal(version(fresh.db), 1);
      fresh.enrollGroup(12, -34);
      assert.equal(fresh.isEnrolled(12, -34), true);
    } finally { fresh.close(); }
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE groups (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id)); INSERT INTO groups VALUES (12,-34);');
    db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new Store(filename);
      try {
        assert.equal(version(store.db), 1);
        assert.equal(store.isEnrolled(12, -34), true);
        store.setSkillCatalog('/project', [{ name: 'example', description: 'saved' }]);
        assert.deepEqual(store.getSkillCatalog('/project'), [{ name: 'example', description: 'saved' }]);
      } finally { store.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
