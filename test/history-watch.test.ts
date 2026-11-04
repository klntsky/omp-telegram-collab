import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readlink, readdir, realpath, rename, rm, stat, symlink, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { HistoryWatch, type HistoryFreshness, type HistoryWatchOptions } from '../src/history-watch.js';

function history(content: string, sessionId = 'native-session'): string {
  return `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: '/fixture' })}\n${content}`;
}

async function fixture(t: TestContext, options: HistoryWatchOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-history-watch-')));
  const file = join(directory, 'history.jsonl');
  await writeFile(file, history('original history\n'));
  let owner: HistoryWatch | undefined;
  t.after(async () => {
    await owner?.close();
    await rm(directory, { recursive: true, force: true });
  });
  owner = await HistoryWatch.open({ sessionId: 'native-session', path: file }, options);
  return { directory, file, owner };
}

async function replace(file: string, content: string, sessionId = 'native-session'): Promise<void> {
  const staged = `${file}.staged`;
  await writeFile(staged, history(content, sessionId));
  await rename(staged, file);
}

async function handlesUnder(directory: string): Promise<string[]> {
  const links = await Promise.all((await readdir('/proc/self/fd')).map(async descriptor => {
    try { return await readlink(`/proc/self/fd/${descriptor}`); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
      throw error;
    }
  }));
  return links.filter(target => target.startsWith(`${directory}/`));
}

test('initial history is untrusted until a pre-snapshot checkpoint is accepted, and append growth stays clean', { timeout: 5000 }, async t => {
  const notifications: HistoryFreshness[] = [];
  const { file, owner } = await fixture(t, { onChange: status => notifications.push(status) });
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  const initial = await owner.capture();
  await appendFile(file, 'a live entry\n');
  assert.equal(await owner.accept(initial), true);
  assert.deepEqual(await owner.check(), { state: 'clean' });
  await appendFile(file, 'another live entry\n');
  assert.deepEqual(await owner.check(), { state: 'clean' });
  const refreshing = await owner.capture();
  await appendFile(file, 'append during snapshot\n');
  assert.equal(await owner.accept(refreshing), true);
  assert.deepEqual(notifications, []);
});

test('directory observation detects repeated same-size atomic replacement and deduplicates checks of each replacement', { timeout: 5000 }, async t => {
  const notifications: HistoryFreshness[] = [];
  let changed = Promise.withResolvers<void>();
  const { directory, file, owner } = await fixture(t, { onChange: status => {
    notifications.push(status);
    changed.resolve();
  } });
  assert.equal(await owner.accept(await owner.capture()), true);
  const original = await stat(file);
  await replace(file, 'rewritten entry\n!');
  await changed.promise;
  assert.notEqual((await stat(file)).ino, original.ino);
  assert.equal((await stat(file)).size, original.size);
  for (let index = 0; index < 4; index++) assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.deepEqual(notifications, [{ state: 'dirty' }]);
  if (process.platform === 'linux') {
    assert.equal((await handlesUnder(directory)).length, 1);
    assert.ok((await handlesUnder(directory))[0]!.endsWith(' (deleted)'));
  }
  assert.equal(await owner.accept(await owner.capture()), true);
  changed = Promise.withResolvers<void>();
  await replace(file, 'second rewrite\n!!');
  await changed.promise;
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.deepEqual(notifications, [{ state: 'dirty' }, { state: 'dirty' }]);
  assert.equal(await owner.accept(await owner.capture()), true);
  assert.deepEqual(await owner.check(), { state: 'clean' });
});

test('same-file shrink and unexplained same-size metadata changes invalidate history', { timeout: 5000 }, async t => {
  const { file, owner } = await fixture(t);
  assert.equal(await owner.accept(await owner.capture()), true);
  await appendFile(file, 'append before shrink\n');
  assert.deepEqual(await owner.check(), { state: 'clean' });
  const before = await stat(file);
  await truncate(file, before.size - 1);
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.equal(await owner.accept(await owner.capture()), true);
  const metadata = await stat(file);
  await utimes(file, metadata.atime, new Date(metadata.mtimeMs + 10_000));
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.equal((await stat(file)).ino, before.ino);
  assert.equal((await stat(file)).size, metadata.size);
});

test('staging another file beside the source never invalidates accepted history', { timeout: 5000 }, async t => {
  const notifications: HistoryFreshness[] = [];
  const { directory, owner } = await fixture(t, { onChange: status => notifications.push(status) });
  assert.equal(await owner.accept(await owner.capture()), true);
  await writeFile(join(directory, 'unrelated.staged'), 'unrelated file');
  await rename(join(directory, 'unrelated.staged'), join(directory, 'unrelated.jsonl'));
  assert.deepEqual(await owner.check(), { state: 'clean' });
  assert.deepEqual(notifications, []);
});

test('read-boundary checks catch a logical symlink retarget outside the observed directory', { timeout: 5000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-history-logical-')));
  let owner: HistoryWatch | undefined;
  t.after(async () => { await owner?.close(); await rm(directory, { recursive: true, force: true }); });
  const physical = join(directory, 'physical');
  const relocated = join(directory, 'relocated');
  const logical = join(directory, 'logical.jsonl');
  await mkdir(physical);
  await mkdir(relocated);
  await writeFile(join(physical, 'first.jsonl'), history('first'));
  await writeFile(join(relocated, 'second.jsonl'), history('other'));
  await symlink(join(physical, 'first.jsonl'), logical);
  const notifications: HistoryFreshness[] = [];
  let changed = Promise.withResolvers<void>();
  owner = await HistoryWatch.open({ sessionId: 'native-session', path: logical }, {
    pollIntervalMs: 60_000, onChange: status => { notifications.push(status); changed.resolve(); },
  });
  assert.equal(await owner.accept(await owner.capture()), true);
  await symlink(join(relocated, 'second.jsonl'), `${logical}.next`);
  await rename(`${logical}.next`, logical);
  assert.deepEqual(notifications, []);
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.equal(await owner.accept(await owner.capture()), true);
  assert.deepEqual(await owner.check(), { state: 'clean' });
  changed = Promise.withResolvers<void>();
  await replace(join(relocated, 'second.jsonl'), 'again');
  await changed.promise;
  assert.deepEqual(await owner.check(), { state: 'dirty' });
});

test('periodic checks detect a lost notification without a history read', { timeout: 5000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-history-poll-')));
  let owner: HistoryWatch | undefined;
  t.after(async () => { await owner?.close(); await rm(directory, { recursive: true, force: true }); });
  const physical = join(directory, 'physical');
  await mkdir(physical);
  const first = join(physical, 'first.jsonl');
  const second = join(physical, 'second.jsonl');
  await writeFile(first, history('first'));
  await writeFile(second, history('other'));
  const logical = join(directory, 'logical.jsonl');
  await symlink(first, logical);
  const changed = Promise.withResolvers<HistoryFreshness>();
  owner = await HistoryWatch.open({ sessionId: 'native-session', path: logical }, {
    pollIntervalMs: 20, onChange: status => changed.resolve(status),
  });
  assert.equal(await owner.accept(await owner.capture()), true);
  await symlink(second, `${logical}.next`);
  await rename(`${logical}.next`, logical);
  assert.deepEqual(await changed.promise, { state: 'dirty' });
});

test('a rewrite during the initial snapshot or a later capture cannot certify a stale candidate', { timeout: 5000 }, async t => {
  const { directory, file, owner } = await fixture(t);
  const initial = await owner.capture();
  await replace(file, 'replacement during initial snapshot');
  assert.equal(await owner.accept(initial), false);
  await owner.discard(initial);
  await owner.discard(initial);
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.equal(await owner.accept(await owner.capture()), true);
  const refresh = await owner.capture();
  await replace(file, 'replacement during refresh');
  await owner.check();
  await appendFile(file, 'ordinary growth after rewrite');
  assert.equal(await owner.accept(refresh), false);
  if (process.platform === 'linux') assert.equal((await handlesUnder(directory)).length, 1);
  assert.equal(await owner.accept(await owner.capture()), true);
  assert.deepEqual(await owner.check(), { state: 'clean' });
});

test('missing files retain original diagnostics, deduplicate notifications, and leave the baseline pinned', { timeout: 5000 }, async t => {
  const notifications: HistoryFreshness[] = [];
  const { directory, file, owner } = await fixture(t, { onChange: status => notifications.push(status) });
  assert.equal(await owner.accept(await owner.capture()), true);
  await unlink(file);
  const result = await owner.check();
  assert.equal(result.state, 'unverified');
  if (result.state !== 'unverified') throw new Error('Expected file diagnostic');
  assert.ok(result.error instanceof Error && 'code' in result.error && 'path' in result.error);
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.error.path, file);
  const reported = notifications.find(status => status.state === 'unverified');
  assert.ok(reported?.state === 'unverified');
  assert.ok(reported.error instanceof Error && 'code' in reported.error && reported.error.code === 'ENOENT');
  assert.equal(result.error, reported.error);
  await owner.check();
  await assert.rejects(owner.capture(), { code: 'ENOENT', path: file });
  assert.equal(notifications.filter(status => status.state === 'unverified').length, 1);
  if (process.platform === 'linux') assert.equal((await handlesUnder(directory)).length, 1);
  await writeFile(file, history('recovered history'));
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.equal(await owner.accept(await owner.capture()), true);
});

test('capture checkpoints are owner-specific, disposable, and all resources close with their owner', { timeout: 5000 }, async t => {
  const notifications: HistoryFreshness[] = [];
  const { directory, file, owner } = await fixture(t, { onChange: status => notifications.push(status) });
  const checkpoint = await owner.capture();
  if (process.platform === 'linux') assert.equal((await handlesUnder(directory)).length, 2);
  await owner.discard(checkpoint);
  await owner.discard(checkpoint);
  await assert.rejects(owner.accept(checkpoint));
  const outstanding = await owner.capture();
  const competing = await fixture(t);
  await assert.rejects(competing.owner.accept(outstanding));
  if (process.platform === 'linux') assert.equal((await handlesUnder(directory)).length, 2);
  const queuedCapture = owner.capture();
  await Promise.resolve();
  const closed = owner.close();
  await assert.rejects(queuedCapture);
  await closed;
  await owner.close();
  await owner.discard(outstanding);
  if (process.platform === 'linux') assert.deepEqual(await handlesUnder(directory), []);
  await replace(file, 'rewrite after close');
  await assert.rejects(owner.check());
  await assert.rejects(owner.capture());
  assert.deepEqual(notifications, []);
});

test('failed setup closes the source handle instead of retaining an unusable owner', { timeout: 5000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-history-setup-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notAFile = join(directory, 'not-a-file');
  await mkdir(notAFile);
  await assert.rejects(HistoryWatch.open({ sessionId: 'native', path: notAFile }));
  await assert.rejects(HistoryWatch.open({ sessionId: 'native', path: join(directory, 'missing') }), { code: 'ENOENT' });
  if (process.platform === 'linux') assert.deepEqual(await handlesUnder(directory), []);
});

test('a replacement with another native session header cannot certify the existing native snapshot', { timeout: 5000 }, async t => {
  const { directory, file, owner } = await fixture(t);
  assert.equal(await owner.accept(await owner.capture()), true);
  const checkpoint = await owner.capture();
  await replace(file, 'history belonging to another native host', 'different-native-session');
  const status = await owner.check();
  assert.equal(status.state, 'unverified');
  if (status.state !== 'unverified') throw new Error('Expected source identity failure');
  assert.ok(status.error instanceof Error);
  assert.match(status.error.message, /expected native-session, found different-native-session/);
  assert.equal(await owner.accept(checkpoint), false);
  await assert.rejects(owner.capture(), error => error === status.error);
  await assert.rejects(HistoryWatch.open({ sessionId: 'native-session', path: file }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /expected native-session, found different-native-session/);
    return true;
  });
  await replace(file, 'history restored to the correct native session');
  assert.deepEqual(await owner.check(), { state: 'dirty' });
  assert.equal(await owner.accept(await owner.capture()), true);
  assert.deepEqual(await owner.check(), { state: 'clean' });
  if (process.platform === 'linux') assert.equal((await handlesUnder(directory)).length, 1);
  await owner.close();
  if (process.platform === 'linux') assert.deepEqual(await handlesUnder(directory), []);
});
