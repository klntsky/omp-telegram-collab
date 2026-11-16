import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorktreeTarget } from '../src/omp.js';
import { initializeDatabase } from '../src/migrations.js';
import { Store } from '../src/store.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
// Execute the schema-9 application's actual Store instead of maintaining a second
// schema definition or manufacturing historical database rows in this test.
const previousRevision = '52a5d1b483d0d1423eb6045ce9b0866b23bb5688';
let previousSource: string;
let PreviousStore: typeof Store;
let target: WorktreeTarget;
const sender = 'Telegram @migration_test';
const image = { text: '', images: [{
  type: 'image' as const, mimeType: 'image/jpeg',
  data: readFileSync(new URL('../assets/telegram-topics.jpg', import.meta.url)).toString('base64'),
}] };

before(async () => {
  previousSource = mkdtempSync(join(tmpdir(), 'omp-previous-application-'));
  const archive = execFileSync('git', ['archive', previousRevision, 'src', 'shared', 'package.json'],
    { cwd: repository, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', previousSource], { input: archive, timeout: 15000 });
  symlinkSync(join(repository, 'node_modules'), join(previousSource, 'node_modules'), 'dir');
  // This module exists only after extracting the old application into a runtime-created directory.
  const application = await import(pathToFileURL(join(previousSource, 'src/store.ts')).href) as { Store: typeof Store };
  PreviousStore = application.Store;
  const metadata = statSync(repository);
  const gitPath = (flag: string) => execFileSync('git', ['rev-parse', '--path-format=absolute', flag],
    { cwd: repository, timeout: 10000, encoding: 'utf8' }).trim();
  target = { path: repository, gitDir: gitPath('--git-dir'), commonDir: gitPath('--git-common-dir'),
    sessionId: 'native-session', dev: metadata.dev, ino: metadata.ino };
});

after(() => { if (previousSource) rmSync(previousSource, { recursive: true, force: true }); });

function oldDatabase(t: TestContext, name = 'store.sqlite') {
  const directory = mkdtempSync(join(tmpdir(), 'omp-upgrade-'));
  const filename = join(directory, name);
  const connections: DatabaseSync[] = [];
  t.after(() => {
    const errors: unknown[] = [];
    for (const db of connections) {
      try { if (db.isOpen) db.close(); } catch (error) { errors.push(error); }
    }
    try { rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors,
      errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
  const previous = new PreviousStore(filename);
  connections.push(previous.db);
  assert.equal(previous.db.prepare('PRAGMA user_version').get()!.user_version, 9);
  return { directory, filename, previous, track(store: Store) { connections.push(store.db); return store; } };
}

function createOldState(store: Store) {
  store.enrollGroup(1, -100);
  const pending = { ...image, text: 'Inspect the upload', documents: [{ fileId: 'pending-document', fileName: 'notes.txt' }] };
  const session = store.createSession({ botId: 1, chatId: -100, threadId: 17, instanceId: 2, cwd: repository },
    'Pending task', { kind: 'managed' }, pending, 41, 42);
  const attached = store.createSession({ botId: 1, chatId: -100, threadId: 18, instanceId: 2, cwd: repository },
    'Attached', { kind: 'attached', instanceId: 'native-host', sessionId: target.sessionId });
  store.setInitialMessage(session.id, 40);
  store.setInitialDocumentSetup(session.id, { automaticWorktree: true, extensions: [{ kind: 'skill', name: 'review' }] });
  store.addPendingSkill({ botId: 1, destination: { kind: 'topic', chatId: -100, threadId: 17 }, userId: 41 }, 'review');
  store.setNewTopicSkills(session.id, ['review']);
  store.recordPromptSubmission(session.id, target.sessionId, sender, { text: 'Accepted task' }, 100);
  store.recordPromptMessageAlias(session.id, 100, 101);
  store.recordPromptReceipt(session.id, { ompSessionId: target.sessionId, entryId: 'accepted', parentEntryId: null },
    sender, { text: 'Accepted task' });
  store.setReplyTarget(session.id, 100);
  store.rememberReply(session.id, target.sessionId, 'assistant-reply');
  const textId = store.recordPromptSubmission(session.id, target.sessionId, sender, { text: 'Pending text' }, 200);
  const imageId = store.recordPromptSubmission(session.id, target.sessionId, sender, image, 201);
  store.markPromptSubmissionUncertain(imageId);
  const mixed = { ...image, text: 'Repeated image task' };
  const interrupted = store.recordPromptSubmission(session.id, target.sessionId, sender, mixed, 202);
  store.markPromptSubmissionUncertain(interrupted);
  store.recordPromptSubmission(session.id, target.sessionId, sender, mixed, 203);
  store.recordPromptReceipt(session.id, { ompSessionId: target.sessionId, entryId: 'ambiguous', parentEntryId: null }, sender, mixed);
  const discardedId = store.recordPromptSubmission(session.id, target.sessionId, sender, { text: 'Rejected' }, 204);
  store.rejectPromptSubmission(discardedId);
  const token = store.worktreeConfirmations.issue(session, 300, 42, target);
  return { session, attached, pending, textId, imageId, discardedId, token };
}

function snapshot(db: DatabaseSync) {
  return new Map(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [String(name), db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()
      .map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))] as const));
}

function backupFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(join(directory, entry.name)).map(name => join(directory, entry.name, name)));
}

test('the real schema-9 application upgrades once with pending work and a private WAL-aware backup intact', t => {
  const context = oldDatabase(t);
  const old = createOldState(context.previous);
  const before = snapshot(context.previous.db);
  const originalSubmissions = before.get('prompt_submissions')!;
  assert.ok(statSync(`${context.filename}-wal`).size > 0);
  const current = context.track(new Store(context.filename));
  assert.equal(current.db.prepare('PRAGMA user_version').get()!.user_version, 10);
  const migrated = snapshot(current.db);
  for (const [table, rows] of before) {
    if (table !== 'prompt_submissions') assert.deepEqual(migrated.get(table), rows);
  }
  for (const original of originalSubmissions) {
    const textOnly = original.id === old.textId;
    const { fingerprint, ...unchanged } = original;
    assert.deepEqual(migrated.get('prompt_submissions')!.find(row => row.id === original.id), {
      ...unchanged, fingerprint: textOnly ? fingerprint : null,
      unresolved_fingerprint: textOnly ? null : fingerprint,
    });
  }
  assert.deepEqual(current.getSession(old.session.id), old.session);
  assert.deepEqual(current.getSession(old.attached.id), old.attached);
  assert.deepEqual(current.getPendingInitialTask(old.session.id), old.pending);
  assert.equal(current.getInitialUser(old.session.id), 41);
  assert.equal(current.getInitialAuthority(old.session.id), 42);
  assert.equal(current.getInitialMessage(old.session.id), 40);
  assert.ok(current.worktreeConfirmations.matches(current.worktreeConfirmations.get(old.session.id, 300, old.token)!, old.session, target));
  const backups = backupFiles(context.directory);
  assert.equal(backups.length, 1);
  assert.equal(statSync(backups[0]!).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(backups[0]!)).mode & 0o777, 0o700);
  const backup = new DatabaseSync(backups[0]!, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 9);
    assert.deepEqual(snapshot(backup), before);
    assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { backup.close(); }
  const newId = current.recordPromptSubmission(old.session.id, target.sessionId, sender, image, 400);
  assert.equal(newId, old.discardedId + 1);
  assert.equal(current.recordPromptReceipt(old.session.id,
    { ompSessionId: target.sessionId, entryId: 'unresolved-image', parentEntryId: null }, sender, image).messageId, undefined);
  assert.equal(current.db.prepare('SELECT unresolved_fingerprint FROM prompt_submissions WHERE id=?').get(old.imageId)?.unresolved_fingerprint,
    originalSubmissions.find(row => row.id === old.imageId)!.fingerprint);
  current.close();
  context.previous.close();
  const reopened = context.track(new Store(context.filename));
  assert.deepEqual(reopened.getPendingInitialTask(old.session.id), old.pending);
  assert.equal(reopened.getMessageAnchor(old.session.id, target.sessionId, -100, 101)?.entryId, 'accepted');
  assert.equal(backupFiles(context.directory).length, 1);
  const fresh = context.track(new Store(':memory:'));
  const schema = (db: DatabaseSync) => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.deepEqual(schema(reopened.db), schema(fresh.db));
});

test('a real SQLite authorization failure rolls back the single migration and retains the backup', t => {
  const context = oldDatabase(t);
  createOldState(context.previous);
  const before = snapshot(context.previous.db);
  context.previous.db.setAuthorizer((action, name) =>
    action === constants.SQLITE_DROP_TABLE && name === 'prompt_submissions' ? constants.SQLITE_DENY : constants.SQLITE_OK);
  assert.throws(() => initializeDatabase(context.previous.db), /not authorized/);
  context.previous.db.setAuthorizer(null);
  assert.equal(context.previous.db.isTransaction, false);
  assert.equal(context.previous.db.prepare('PRAGMA user_version').get()!.user_version, 9);
  assert.deepEqual(snapshot(context.previous.db), before);
  assert.equal(backupFiles(context.directory).length, 1);
  context.previous.close();
  const upgraded = context.track(new Store(context.filename));
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 10);
});

test('a real backup path failure leaves the previous application database unchanged', t => {
  const context = oldDatabase(t, 'x'.repeat(245));
  createOldState(context.previous);
  const before = snapshot(context.previous.db);
  context.previous.close();
  assert.throws(() => new Store(context.filename),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENAMETOOLONG');
  const previous = context.track(new PreviousStore(context.filename));
  assert.equal(previous.db.prepare('PRAGMA user_version').get()!.user_version, 9);
  assert.deepEqual(snapshot(previous.db), before);
  assert.deepEqual(backupFiles(context.directory), []);
});

test('unsupported future-version metadata is rejected without changing the actual application database', t => {
  const context = oldDatabase(t);
  createOldState(context.previous);
  context.previous.close();
  const current = context.track(new Store(context.filename));
  current.db.exec('PRAGMA user_version=11');
  current.close();
  chmodSync(context.filename, 0o640);
  const before = readFileSync(context.filename);
  const files = readdirSync(context.directory);
  assert.throws(() => new Store(context.filename), /Unsupported database schema version 11/);
  assert.deepEqual(readFileSync(context.filename), before);
  assert.equal(statSync(context.filename).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(context.directory), files);
});

function receive(child: ChildProcess, expected: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.on('message', message => { if (message === expected) resolve(); });
  child.once('error', reject);
  const exited = () => reject(new Error(`Migration process exited ${child.exitCode} (${child.signalCode}) before ${expected}`));
  child.once('exit', exited);
  if (child.exitCode !== null || child.signalCode !== null) exited();
  return promise;
}

test('two real Store processes serialize one upgrade and create one backup', { timeout: 15000 }, async t => {
  const context = oldDatabase(t);
  createOldState(context.previous);
  context.previous.close();
  const lock = new DatabaseSync(context.filename);
  const children: ChildProcess[] = [];
  try {
    lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const source = `
      import { Store } from ${JSON.stringify(pathToFileURL(join(repository, 'src/store.ts')).href)};
      process.send('ready');
      process.once('message', () => {
        process.send('entering');
        const store = new Store(process.argv[1]);
        store.close();
        process.send('finished', () => process.disconnect());
      });
    `;
    for (let i = 0; i < 2; i++) children.push(spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source, context.filename],
      { cwd: repository, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
    await Promise.all(children.map(child => receive(child, 'ready')));
    const entering = children.map(child => receive(child, 'entering'));
    for (const child of children) child.send('initialize');
    await Promise.all(entering);
    assert.equal(lock.prepare('PRAGMA user_version').get()!.user_version, 9);
    lock.exec('COMMIT');
    await Promise.all(children.map(child => receive(child, 'finished')));
    assert.equal(lock.prepare('PRAGMA user_version').get()!.user_version, 10);
    assert.equal(backupFiles(context.directory).length, 1);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit')));
  }
});
