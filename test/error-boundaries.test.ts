import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { AuthenticationError, validateInitData } from '../src/auth.js';
import { HistorySourceError } from '../src/history-errors.js';
import { HistoryWatch } from '../src/history-watch.js';
import { GatewayInputError, parseGatewayInput } from '../src/server-input.js';
import { StoreOperationError, rollbackStore } from '../src/store/errors.js';
import { botToken, signedInitData } from './telegram-data.js';
import { ConfigError, readConfig } from '../src/config.js';

test('authentication parsing translates malformed signed user data and retains its native cause', () => {
  const seconds = 1_800_000_000;
  const raw = signedInitData('RkJQtSOXgS9CFpCqE_BxYg', {authDate: seconds, extra: {user: 'not-json'}});
  assert.throws(() => validateInitData(raw, botToken, {now: seconds * 1000}), error => {
    assert.ok(error instanceof AuthenticationError);
    assert.ok(error.cause instanceof SyntaxError);
    assert.ok(error.message.includes(error.cause.message));
    assert.ok(!error.message.includes(botToken));
    return true;
  });
});

test('gateway parsing translates native validation failures without reclassifying unexpected failures', () => {
  const cause = new SyntaxError('invalid JSON\nbyte 17');
  assert.throws(() => parseGatewayInput('session request 42', () => { throw cause; }), error => {
    assert.ok(error instanceof GatewayInputError);
    assert.equal(error.cause, cause);
    assert.ok(error.message.includes('session request 42'));
    assert.ok(error.message.includes(cause.message));
    return true;
  });
  const defect = new TypeError('unexpected callback failure');
  assert.throws(() => parseGatewayInput('session request 42', () => { throw defect; }), error => error === defect);
});

test('missing managed history retains the filesystem diagnostic and session context', async () => {
  const path = join(tmpdir(), randomUUID(), 'history.jsonl');
  await assert.rejects(HistoryWatch.open({sessionId: 'missing-history-session', path}), error => {
    assert.ok(error instanceof HistorySourceError);
    assert.ok(error.cause instanceof Error && 'code' in error.cause);
    assert.equal(error.cause.code, 'ENOENT');
    assert.ok(error.message.includes(path));
    assert.ok(error.message.includes('missing-history-session'));
    assert.ok(error.message.includes(error.cause.message));
    return true;
  });
});

test('store rollback preserves primary diagnostics and reverses partial mutation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE values_to_rollback (value INTEGER); BEGIN; INSERT INTO values_to_rollback VALUES (1)');
    const primary = new Error('failed write\noriginal diagnostic');
    assert.throws(() => rollbackStore(db, 'update session 42', primary), error => {
      assert.ok(error instanceof StoreOperationError);
      assert.equal(error.cause, primary);
      assert.ok(error.message.includes('update session 42'));
      assert.ok(error.message.includes(primary.message));
      return true;
    });
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM values_to_rollback').get()!.count, 0);
  } finally { db.close(); }
});

test('YAML configuration diagnostics retain locations without leaking credential-bearing source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-error-boundary-'));
  const filename = join(directory, 'config.yaml');
  const secret = '123456789:private-token';
  try {
    await writeFile(filename, `token: |${secret}\n`, {mode: 0o600});
    assert.throws(() => readConfig(filename), error => {
      assert.ok(error instanceof ConfigError);
      assert.ok(!inspect(error, {depth: null}).includes(secret));
      assert.ok(error.message.includes('UNEXPECTED_TOKEN'));
      assert.ok(error.message.includes('line 1'));
      assert.ok(error.message.includes(filename));
      return true;
    });
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('malformed history headers retain the native parse diagnostic and physical source identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-header-boundary-'));
  const path = join(directory, 'history.jsonl');
  try {
    await writeFile(path, '{malformed\n');
    await assert.rejects(HistoryWatch.open({sessionId: 'malformed-history-session', path}), error => {
      assert.ok(error instanceof HistorySourceError);
      assert.ok(error.cause instanceof SyntaxError);
      assert.ok(error.message.includes(path));
      assert.ok(error.message.includes('malformed-history-session'));
      assert.ok(error.message.includes(error.cause.message));
      return true;
    });
  } finally { await rm(directory, {recursive: true, force: true}); }
});
