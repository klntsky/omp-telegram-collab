import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readStringSession, writeStringSession } from '@mtcute/node/utils.js';
import { readTelegramTestCredentials, readTelegramTestSessions } from '../scripts/lib/telegram-test-auth.js';
import { appendTelegramTestSession, withTelegramTestSessionStorage } from './e2e/helpers/telegram-env.js';
import { compactTelegramTestEnv, withTelegramTestEnvStorage } from '../scripts/lib/telegram-test-env-storage.js';
import { withTelegramTestLock } from '../scripts/lib/telegram-test-lock.js';

function session(seed: number, testMode = true, isBot = false): string {
  return writeStringSession(readStringSession({
    testMode,
    authKey: new Uint8Array(256).fill(seed),
    self: { userId: seed, isBot, isPremium: false, usernames: [] },
  }));
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-telegram-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: join(directory, '.env') };
}

test('canonical sessions validate the entire unique list and credentials select its first entry', () => {
  const first = session(1); const second = session(2);
  const env = { TELEGRAM_TEST_API_ID: '1', TELEGRAM_TEST_API_HASH: 'hash', TELEGRAM_TEST_SESSIONS: JSON.stringify([first, second]) };
  assert.deepEqual(readTelegramTestSessions(env), [first, second]);
  assert.equal(readTelegramTestCredentials(env).session, first);
  for (const value of ['', 'no-json', '{}', '[]', '[null]', '[" "]', JSON.stringify([first, first]), JSON.stringify([first, session(3, false)]), JSON.stringify([first, session(3, true, true)])]) {
    assert.throws(() => readTelegramTestSessions({ TELEGRAM_TEST_SESSIONS: value }));
  }
  assert.throws(() => readTelegramTestSessions({ TELEGRAM_TEST_SESSION: first }));
});

test('concurrent appends retain existing sessions, unrelated dotenv bytes and deduplicate', async t => {
  const { filename } = await fixture(t);
  const first = session(1); const second = session(2); const third = session(3);
  const original = `# keep this comment\nUNRELATED="unchanged value"\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([first])}'\n`;
  await writeFile(filename, original, { mode: 0o644 });
  await Promise.all([appendTelegramTestSession(filename, second), appendTelegramTestSession(filename, third), appendTelegramTestSession(filename, second)]);
  const contents = await readFile(filename, 'utf8');
  assert.equal(parseEnv(contents).UNRELATED, 'unchanged value');
  assert.deepEqual(new Set(readTelegramTestSessions(parseEnv(contents))), new Set([first, second, third]));
  assert.equal(contents.match(/^TELEGRAM_TEST_SESSIONS=/gm)?.length, 1);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await appendTelegramTestSession(filename, first);
  assert.equal(await readFile(filename, 'utf8'), contents);
});

test('invalid existing canonical state is unchanged and does not poison later appends', async t => {
  const { filename } = await fixture(t);
  const original = "UNRELATED=value\nTELEGRAM_TEST_SESSIONS='[null]'\n";
  await writeFile(filename, original);
  await assert.rejects(appendTelegramTestSession(filename, session(1)));
  assert.equal(await readFile(filename, 'utf8'), original);
  await writeFile(filename, 'UNRELATED=value\n');
  await appendTelegramTestSession(filename, session(2));
  assert.deepEqual(readTelegramTestSessions(parseEnv(await readFile(filename, 'utf8'))), [session(2)]);
});

test('symlink and hard-link targets are never modified', async t => {
  const { directory, filename } = await fixture(t);
  const target = join(directory, 'target');
  const contents = 'UNRELATED=preserve\n';
  await writeFile(target, contents, { mode: 0o644 });
  await symlink(target, filename);
  await assert.rejects(appendTelegramTestSession(filename, session(1)));
  assert.equal(await readFile(target, 'utf8'), contents);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  const hardlink = join(directory, 'hardlink');
  await link(target, hardlink);
  await assert.rejects(appendTelegramTestSession(hardlink, session(1)));
  assert.equal(await readFile(target, 'utf8'), contents);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test('saving collapses historical lists without resurrecting removed sessions or changing multiline values', async t => {
  const { filename } = await fixture(t);
  const first = session(1); const retained = session(2); const added = session(3);
  const before = '# retained comment\r\nSINGLE=\'first\r\nTELEGRAM_TEST_SESSIONS=not-an-assignment\r\nlast\' # single comment\r\n';
  const between = 'DOUBLE="line\\nvalue\r\nTELEGRAM_TEST_SESSIONS=also-not-an-assignment"\r\nBACKTICK=`line\r\nTELEGRAM_TEST_SESSIONS=still-not-an-assignment`\r\n';
  const after = '# retained end\r\nNO_NEWLINE=unchanged';
  await writeFile(filename, `${before}TELEGRAM_TEST_SESSIONS='${JSON.stringify([first, retained])}' # historical\r\n${between}export TELEGRAM_TEST_SESSIONS = '${JSON.stringify([retained])}' # current\r\n${after}`);
  await appendTelegramTestSession(filename, added);
  assert.equal(await readFile(filename, 'utf8'), `${before} # historical\r\n${between}TELEGRAM_TEST_SESSIONS='${JSON.stringify([retained, added])}' # current\r\n${after}`);
  await appendTelegramTestSession(filename, added);
  assert.deepEqual(readTelegramTestSessions(parseEnv(await readFile(filename, 'utf8'))), [retained, added]);
});

test('multiple saves use the replacement inode and no-op saves retain it while securing permissions', async t => {
  const { filename } = await fixture(t);
  await writeFile(filename, `UNRELATED=keep\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([session(1)])}'\n`, { mode: 0o644 });
  await withTelegramTestLock('authorization', new AbortController().signal, () => withTelegramTestSessionStorage(filename, async storage => {
    const initial = await stat(filename);
    await storage.save([session(1)]);
    assert.equal((await stat(filename)).ino, initial.ino);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await storage.save([session(1), session(2)]);
    assert.notEqual((await stat(filename)).ino, initial.ino);
    await storage.save([session(2)]);
    assert.deepEqual(readTelegramTestSessions(parseEnv(await readFile(filename, 'utf8'))), [session(2)]);
  }));
  assert.equal((await readFile(filename, 'utf8')).match(/^TELEGRAM_TEST_SESSIONS=/gm)?.length, 1);
});

test('operational compaction retains final assignments verbatim and all parsed values', async t => {
  const { filename } = await fixture(t);
  const current = `export TELEGRAM_TEST_SESSIONS = '${JSON.stringify([session(2), session(3)], null, 2)}'`;
  const currentBots = `TELEGRAM_TEST_BOT_TOKENS = '["latest-token"]'`;
  const unrelated = 'OTHER=`value\nTELEGRAM_TEST_BOT_TOKENS=inside-value`\n';
  const original = `TELEGRAM_TEST_SESSIONS='${JSON.stringify([session(1)])}' # old\nTELEGRAM_TEST_BOT_TOKENS='[\"old-token\"]'\n${unrelated}${current} # latest\n${currentBots}\n`;
  await writeFile(filename, original, { mode: 0o644 });
  await compactTelegramTestEnv(filename, new AbortController().signal);
  const compacted = await readFile(filename, 'utf8');
  assert.deepEqual(parseEnv(compacted), parseEnv(original));
  assert.equal(compacted, ` # old\n\n${unrelated}${current} # latest\n${currentBots}\n`);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await compactTelegramTestEnv(filename, new AbortController().signal);
  assert.equal(await readFile(filename, 'utf8'), compacted);
});

test('cancellation after staging retains the original inode and cleans up the private replacement', async t => {
  const { directory, filename } = await fixture(t);
  const original = `UNRELATED=keep\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([session(1)])}'\n`;
  await writeFile(filename, original);
  const initial = await stat(filename);
  const controller = new AbortController();
  const reason = new Error('cancel staged credential replacement');
  let boundaries = 0;
  t.mock.method(controller.signal, 'throwIfAborted', () => {
    if (++boundaries === 2) throw reason;
  });
  await assert.rejects(withTelegramTestLock('authorization', new AbortController().signal, () =>
    withTelegramTestEnvStorage(filename, storage => storage.save('TELEGRAM_TEST_SESSIONS', JSON.stringify([session(2)])), controller.signal)),
  error => error === reason);
  assert.equal(boundaries, 2);
  assert.equal(await readFile(filename, 'utf8'), original);
  assert.equal((await stat(filename)).ino, initial.ino);
  assert.deepEqual(await readdir(directory), ['.env']);
});

test('a changed target during authorization is never overwritten by a stale storage snapshot', async t => {
  const { filename } = await fixture(t);
  await writeFile(filename, `TELEGRAM_TEST_SESSIONS='${JSON.stringify([session(1)])}'\n`);
  const externallyChanged = `UNRELATED=changed\nTELEGRAM_TEST_SESSIONS='${JSON.stringify([session(2)])}'\n`;
  await withTelegramTestLock('authorization', new AbortController().signal, () => withTelegramTestSessionStorage(filename, async storage => {
    await writeFile(filename, externallyChanged);
    await assert.rejects(storage.save([session(3)]));
  }));
  assert.equal(await readFile(filename, 'utf8'), externallyChanged);
});
