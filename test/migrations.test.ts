import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { initializeDatabase } from '../src/migrations.js';

const topic = { botId: 1, chatId: -100, threadId: 17, instanceId: 1, cwd: '/work/project' };
const panel = {
  token: 'persisted-panel', chatId: topic.chatId, instanceId: 1, messageId: 50,
  destination: { kind: 'topic', chatId: topic.chatId, threadId: topic.threadId },
  revision: 7, offset: 8,
  choices: [{ kind: 'default', field: 'default_new_topic_skill', value: 'team:Review' }],
  changes: [['skills', { label: 'Default skill', before: 'No default skill', after: 'team:Review' }]],
  folderInput: 'append',
};

function restoreSchemaFive(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE new_topic_skills RENAME COLUMN names TO name;
    UPDATE new_topic_skills SET name = json_extract(name, '$[0]');
    PRAGMA user_version=5;
  `);
}

function preservedRows(db: DatabaseSync) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'sqlite_%' AND name NOT IN ('new_topic_skills','settings_panels') ORDER BY name`).all();
  return Object.fromEntries(tables.map(row => {
    const name = String(row.name);
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()];
  }));
}

test('schema 5 upgrades on disk without losing settings, sessions, tasks, or exact skill names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-schema-upgrade-'));
  const filename = join(directory, 'telegram.sqlite');
  let store = new Store(filename);
  try {
    store.enrollGroup(topic.botId, topic.chatId);
    const source = store.createSession(topic, 'Existing session', { kind: 'managed' }, { text: 'Pending task' }, 42, 43);
    const literal = store.createSession({ ...topic, threadId: 18 }, 'Literal skill name');
    const noDefault = store.createSession({ ...topic, threadId: 19 }, 'No default');
    store.setNewTopicSkills(source.id, ['team:Review']);
    store.setNewTopicSkills(literal.id, ['["literal"]']);
    const pending = { botId: 1, destination: { kind: 'topic' as const, chatId: -100, threadId: 17 }, userId: 42 };
    store.addPendingSkill(pending, 'Explicit');
    store.setSkillCatalog(1, [{ name: 'team:Review', description: 'Saved catalog' }]);
    store.setSessionEntry(source.id, 51, '{}');
    store.recordPromptSubmission(source.id, 'native-session', 'Telegram user', { text: 'Pending delivery' }, 52);
    store.recordPromptMessageAlias(source.id, 52, 53);
    store.db.prepare('INSERT INTO settings_panels VALUES (?,?,?)').run(1, panel.token, JSON.stringify(panel));
    restoreSchemaFive(store.db);
    const before = preservedRows(store.db);
    store.close();

    store = new Store(filename);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.deepEqual(preservedRows(store.db), before);
    assert.deepEqual(store.getSession(source.id), source);
    assert.deepEqual(store.getNewTopicSkills(source.id), ['team:Review']);
    assert.deepEqual(store.getNewTopicSkills(literal.id), ['["literal"]']);
    assert.deepEqual(store.getNewTopicSkills(noDefault.id), []);
    assert.deepEqual(store.getPendingSkills(pending), ['Explicit']);
    const migratedPanel = JSON.parse(String(store.db.prepare('SELECT panel FROM settings_panels WHERE token=?').get(panel.token)!.panel));
    assert.deepEqual(migratedPanel, { ...panel, revision: 8 });
    initializeDatabase(store.db);
    assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT panel FROM settings_panels WHERE token=?').get(panel.token)!.panel)), migratedPanel);
    store.close();

    store = new Store(filename);
    assert.deepEqual(preservedRows(store.db), before);
    assert.deepEqual(store.getNewTopicSkills(source.id), ['team:Review']);
    assert.deepEqual(store.getNewTopicSkills(literal.id), ['["literal"]']);
    assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT panel FROM settings_panels WHERE token=?').get(panel.token)!.panel)), migratedPanel);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed upgrade rolls back its schema, data, and version with the original SQLite diagnostic', () => {
  const store = new Store(':memory:');
  try {
    const source = store.createSession(topic, 'Existing session');
    store.setNewTopicSkills(source.id, ['team:Review']);
    store.db.prepare('INSERT INTO settings_panels VALUES (?,?,?)').run(1, panel.token, JSON.stringify(panel));
    restoreSchemaFive(store.db);
    store.db.exec(`CREATE TRIGGER reject_panel_upgrade BEFORE UPDATE ON settings_panels
      BEGIN SELECT RAISE(ABORT,'Original panel migration failure'); END;`);

    assert.throws(() => initializeDatabase(store.db), { message: 'Original panel migration failure' });
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 5);
    assert.deepEqual(store.db.prepare('PRAGMA table_info(new_topic_skills)').all().map(row => row.name), ['session_id', 'name']);
    assert.equal(store.db.prepare('SELECT name FROM new_topic_skills WHERE session_id=?').get(source.id)!.name, 'team:Review');
    assert.equal(store.db.prepare('SELECT panel FROM settings_panels WHERE token=?').get(panel.token)!.panel, JSON.stringify(panel));
    assert.deepEqual(store.getSession(source.id), source);

    store.db.exec('DROP TRIGGER reject_panel_upgrade');
    initializeDatabase(store.db);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.deepEqual(store.getNewTopicSkills(source.id), ['team:Review']);
    assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT panel FROM settings_panels WHERE token=?').get(panel.token)!.panel)), { ...panel, revision: 8 });
  } finally {
    store.close();
  }
});
