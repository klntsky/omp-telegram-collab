import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { databaseMigrations } from '../src/database-migrations.js';
import { initializeDatabase } from '../src/migrations.js';
import { promptFingerprint } from '../src/prompt-fingerprint.js';
import { Store } from '../src/store.js';

const legacyImageFingerprint = createHash('sha256').update(JSON.stringify(['image', [['image/png', 'aGVsbG8=']]])).digest('hex');
const legacyMixedFingerprint = createHash('sha256').update(JSON.stringify(['mixed', [['image/png', 'aGVsbG8=']]])).digest('hex');

function historical(db: DatabaseSync, version: number): void {
  db.exec('BEGIN IMMEDIATE');
  db.exec(readFileSync(new URL(`./fixtures/schema-${version}.sql`, import.meta.url), 'utf8'));
  db.exec(`INSERT INTO sessions VALUES ('session',1,-100,17,2,'/work/project','Historical','open','{"kind":"managed"}',123,'task','pending');
    INSERT INTO initial_users VALUES ('session',41);
    INSERT INTO initial_authorities VALUES ('session',42);
    INSERT INTO initial_images VALUES ('session','[{"type":"image","mimeType":"image/png","data":"aGVsbG8="}]');
    INSERT INTO initial_documents VALUES ('session','[{"fileId":"document-id","fileName":"notes.txt"}]');
    INSERT INTO initial_document_setups VALUES ('session','{"automaticWorktree":true,"extensions":[{"kind":"skill","name":"review"}]}');
    INSERT INTO initial_task_preparations VALUES ('session','fork');
    INSERT INTO initial_messages VALUES ('session',10);
    INSERT INTO reply_targets VALUES ('session',11);
    INSERT INTO replies VALUES ('session','runtime-id','reply');
    INSERT INTO prompt_message_aliases VALUES ('session',12,13);
    INSERT INTO message_anchors VALUES ('session','runtime-id',-100,14,'entry','parent','assistant',2);`);
  const insert = db.prepare('INSERT INTO prompt_submissions VALUES (?,?,?,?,?,?,?,?)');
  insert.run(7,'session','runtime-id','ada',12,'text',promptFingerprint({text:'text'}),'pending');
  insert.run(9,'session','runtime-id','ada',null,'image',legacyImageFingerprint,'uncertain');
  insert.run(11,'session','runtime-id','bob',15,'mixed',legacyMixedFingerprint,'ambiguous');
  db.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='prompt_submissions'");
  if (version === 7) db.exec("INSERT INTO prompt_receipts VALUES ('session','runtime-id','local',12),('session','runtime-id','external',NULL)");
  else db.exec("INSERT INTO prompt_receipts VALUES ('session','runtime-id','local',12,1),('session','runtime-id','external',NULL,0)");
  if (version === 9) db.exec("INSERT INTO worktree_confirmations VALUES ('session',20,42,'token','identity')");
  db.exec('COMMIT');
}

function rows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({...row}));
}
function version(db: DatabaseSync) { return db.prepare('PRAGMA user_version').get()!.user_version; }
function schema(db: DatabaseSync) {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.name, String(row.sql).replace(/\s+/g,' ').replace(/IF NOT EXISTS /g,'').replace(/"/g,'').trim()]);
}
const preserved = ['sessions','initial_users','initial_authorities','initial_images','initial_documents','initial_document_setups','initial_task_preparations','initial_messages','reply_targets','replies','prompt_message_aliases','message_anchors'];

for (const start of [7,8,9]) {
  test(`schema ${start} migrates with identities, provenance and all pending state intact`, () => {
    const db = new DatabaseSync(':memory:');
    const fresh = new DatabaseSync(':memory:');
    try {
      historical(db,start);
      const before = preserved.map(table => rows(db,table));
      initializeDatabase(db);
      assert.equal(version(db),10);
      assert.deepEqual(preserved.map(table => rows(db,table)),before);
      const submissions = rows(db,'prompt_submissions');
      assert.deepEqual(submissions.map(row => [row.id,row.session_id,row.omp_session_id,row.sender,row.message_id,row.text,row.state]),[
        [7,'session','runtime-id','ada',12,'text','pending'],[9,'session','runtime-id','ada',null,'image','uncertain'],[11,'session','runtime-id','bob',15,'mixed','ambiguous'],
      ]);
      assert.deepEqual(submissions.map(row => [row.fingerprint,row.unresolved_fingerprint]),[
        [promptFingerprint({text:'text'}),null],[null,legacyImageFingerprint],[null,legacyMixedFingerprint],
      ]);
      assert.deepEqual(rows(db,'prompt_receipts').map(row => [row.entry_id,row.message_id,row.submitted_locally]),[['local',12,1],['external',null,start===7?null:0]]);
      if (start===9) assert.deepEqual(rows(db,'worktree_confirmations'),[{session_id:'session',message_id:20,admin_id:42,token:'token',identity:'identity'}]);
      const inserted = db.prepare("INSERT INTO prompt_submissions (session_id,omp_session_id,sender,message_id,text,fingerprint,state) VALUES ('session','runtime-id','ada',99,'next',?,'pending')").run(promptFingerprint({text:'next'}));
      assert.equal(Number(inserted.lastInsertRowid),101);
      initializeDatabase(fresh);
      assert.deepEqual(schema(db),schema(fresh));
      const after = rows(db,'prompt_submissions');
      initializeDatabase(db);
      assert.deepEqual(rows(db,'prompt_submissions'),after);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally { db.close(); fresh.close(); }
  });
}

test('ordered exported migration steps work independently against deployed schemas', () => {
  assert.deepEqual(databaseMigrations.map(({from,to}) => [from,to]),[[7,8],[8,9],[9,10]]);
  for (const step of databaseMigrations) {
    const db = new DatabaseSync(':memory:');
    try {
      historical(db,step.from);
      const before = preserved.map(table => rows(db,table));
      db.exec('BEGIN IMMEDIATE');
      step.apply(db);
      db.exec(`PRAGMA user_version=${step.to}; COMMIT`);
      assert.equal(version(db),step.to);
      assert.deepEqual(preserved.map(table => rows(db,table)),before);
      if (step.to===8) assert.deepEqual(rows(db,'prompt_receipts').map(row => row.submitted_locally),[1,null]);
      if (step.to===9) {
        db.exec("INSERT INTO worktree_confirmations VALUES ('session',20,42,'token','identity')");
        assert.deepEqual(rows(db,'worktree_confirmations'),[{session_id:'session',message_id:20,admin_id:42,token:'token',identity:'identity'}]);
      }
      if (step.to===10) assert.equal(rows(db,'prompt_submissions')[1]!.unresolved_fingerprint,legacyImageFingerprint);
    } finally { db.close(); }
  }
});

function diskTest(run: (directory: string, filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(),'omp-migration-'));
  try { run(directory,join(directory,'store.sqlite')); }
  finally { rmSync(directory,{recursive:true,force:true}); }
}
function backups(directory: string): string[] {
  return readdirSync(directory,{withFileTypes:true}).filter(entry => entry.isDirectory()).flatMap(entry =>
    readdirSync(join(directory,entry.name)).map(name => join(directory,entry.name,name)));
}

test('WAL backup retains committed historical data, private modes and survives reopening', () => diskTest((directory,filename) => {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    historical(db,7);
    assert.ok(statSync(`${filename}-wal`).size>0);
    initializeDatabase(db);
    const files = backups(directory);
    assert.equal(files.length,1);
    assert.equal(statSync(files[0]!).mode & 0o777,0o600);
    assert.equal(statSync(join(files[0]!,'..')).mode & 0o777,0o700);
    const backup = new DatabaseSync(files[0]!,{readOnly:true});
    try {
      assert.equal(version(backup),7);
      assert.deepEqual(rows(backup,'sessions'),rows(db,'sessions'));
      assert.equal(rows(backup,'prompt_submissions')[1]!.fingerprint,legacyImageFingerprint);
      assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    } finally { backup.close(); }
  } finally { db.close(); }
  const reopened = new DatabaseSync(filename);
  try { initializeDatabase(reopened); assert.equal(version(reopened),10); assert.equal(rows(reopened,'sessions').length,1); assert.equal(backups(directory).length,1); }
  finally { reopened.close(); }
}));

test('failed later migration rolls back the whole chain, version and data with original diagnostic', () => diskTest((directory,filename) => {
  const db = new DatabaseSync(filename);
  try {
    historical(db,7);
    db.exec('CREATE VIEW worktree_confirmations AS SELECT 1 AS collision');
    const before = rows(db,'prompt_submissions');
    assert.throws(() => initializeDatabase(db), /worktree_confirmations.*already exists/i);
    assert.equal(version(db),7);
    assert.deepEqual(rows(db,'prompt_submissions'),before);
    assert.equal(db.prepare('PRAGMA table_info(prompt_receipts)').all().some(row => row.name==='submitted_locally'),false);
    assert.equal(db.isTransaction,false);
    assert.equal(backups(directory).length,1);
  } finally { db.close(); }
}));

test('newer schema rejection leaves bytes, journal, permissions and directory untouched', () => diskTest((directory,filename) => {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE future (value TEXT); INSERT INTO future VALUES (\'untouched\'); PRAGMA user_version=11');
  db.close();
  chmodSync(filename,0o640);
  const before = readFileSync(filename);
  assert.throws(() => new Store(filename),/Unsupported database schema version 11/);
  const opened = new DatabaseSync(filename);
  try {
    const journal = opened.prepare('PRAGMA journal_mode').get();
    assert.throws(() => initializeDatabase(opened),/Unsupported database schema version 11/);
    assert.deepEqual(opened.prepare('PRAGMA journal_mode').get(),journal);
  } finally { opened.close(); }
  assert.deepEqual(readFileSync(filename),before);
  assert.equal(statSync(filename).mode & 0o777,0o640);
  assert.deepEqual(readdirSync(directory),['store.sqlite']);
}));

test('fresh on-disk initialization creates no backup', () => diskTest((directory,filename) => {
  const db = new DatabaseSync(filename);
  try {
    initializeDatabase(db);
    assert.equal(version(db),10);
    assert.deepEqual(backups(directory),[]);
  } finally { db.close(); }
}));

test('backup failure prevents every migration and retains the original error', t => diskTest((directory,filename) => {
  const db = new DatabaseSync(filename);
  const failure = new Error('backup destination unavailable');
  try {
    historical(db,7);
    const before = rows(db,'prompt_submissions');
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype,'prepare',function (this: DatabaseSync, sql: string) {
      if (sql === 'VACUUM main INTO ?') throw failure;
      return prepare.call(this,sql);
    });
    assert.throws(() => initializeDatabase(db),error => error===failure);
    assert.equal(version(db),7);
    assert.deepEqual(rows(db,'prompt_submissions'),before);
    assert.equal(db.prepare('PRAGMA table_info(prompt_receipts)').all().some(row => row.name==='submitted_locally'),false);
    assert.equal(db.isTransaction,false);
    assert.equal(backups(directory).length,1);
  } finally { db.close(); }
}));

function receive(child: ChildProcess, expected: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.on('message', message => { if (message===expected) resolve(); });
  child.once('error',reject);
  const exited = () => reject(new Error(`migration worker exited ${child.exitCode} (${child.signalCode}) before ${expected}`));
  child.once('exit',exited);
  if (child.exitCode !== null || child.signalCode !== null) exited();
  return promise;
}

test('concurrent startup waits on a real writer barrier and produces only one upgrade backup', {timeout:15000}, async () => {
  const directory = mkdtempSync(join(tmpdir(),'omp-migration-concurrent-'));
  const filename = join(directory,'store.sqlite');
  const lock = new DatabaseSync(filename);
  const children: ChildProcess[] = [];
  try {
    historical(lock,7);
    lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    for (let i=0;i<2;i++) children.push(fork(new URL('./fixtures/migration-worker.ts',import.meta.url),[filename],{execArgv:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc']}));
    await Promise.all(children.map(child => receive(child,'ready')));
    const entering = children.map(child => receive(child,'entering'));
    for (const child of children) child.send('initialize');
    await Promise.all(entering);
    assert.equal(version(lock),7);
    lock.exec('COMMIT');
    const finished = children.map(child => receive(child,'finished'));
    await Promise.all(finished);
    assert.equal(version(lock),10);
    assert.equal(rows(lock,'prompt_submissions').length,3);
    assert.equal(backups(directory).length,1);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
    for (const child of children) child.kill();
    rmSync(directory,{recursive:true,force:true});
  }
});
