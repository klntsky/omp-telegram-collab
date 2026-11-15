import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeJson, InvalidJsonError } from '../web/src/lib/decode.js';
import { parseJsonl } from '../web/src/lib/jsonl.js';
import { accessBrowserStorage, BrowserStorageUnavailableError } from '../web/src/lib/storage.js';
import { MissingResourceError, systemOperation } from '../scripts/lib/system-errors.js';

test('JSON validation retains native diagnostics and cause while JSONL skips only malformed complete records', () => {
  assert.throws(() => decodeJson('{invalid', 'Decode transcript agent child-1'), error => {
    assert.ok(error instanceof InvalidJsonError);
    assert.ok(error.cause instanceof SyntaxError);
    assert.ok(error.message.includes(error.cause.message));
    assert.ok(error.message.includes('child-1'));
    return true;
  });
  assert.deepEqual(parseJsonl('{invalid\n{"id":1}\n{"id":', ''), { items: [{ id: 1 }], carry: '{"id":' });
});

test('blocked browser storage is typed but unexpected storage failures preserve identity', () => {
  const blocked = new DOMException('Storage disabled by policy', 'SecurityError');
  assert.throws(() => accessBrowserStorage('Read preference', 'theme', () => { throw blocked; }), error => {
    assert.ok(error instanceof BrowserStorageUnavailableError);
    assert.equal(error.cause, blocked);
    assert.ok(error.message.includes(blocked.message));
    assert.ok(error.message.includes('theme'));
    return true;
  });
  const unexpected = new TypeError('Broken storage integration');
  assert.throws(() => accessBrowserStorage('Read preference', 'theme', () => { throw unexpected; }), error => error === unexpected);
});

test('missing filesystem resources translate at the integration boundary without masking unrelated failures', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-error-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'missing');
  await assert.rejects(systemOperation(`Read fixture ${path}`, () => readFile(path)), error => {
    assert.ok(error instanceof MissingResourceError);
    assert.ok(error.cause instanceof Error && 'code' in error.cause && 'path' in error.cause);
    assert.equal(error.cause.code, 'ENOENT');
    assert.equal(error.cause.path, path);
    assert.ok(error.message.includes(error.cause.message));
    return true;
  });
  const unexpected = new TypeError('Unrelated failure');
  await assert.rejects(systemOperation('Read fixture', async () => { throw unexpected; }), error => error === unexpected);
});
