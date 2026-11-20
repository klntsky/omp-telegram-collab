import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readPromptReceipt } from '../src/prompt-receipt.js';

const header = { type: 'session', version: 3, id: 'session-a', cwd: '/fixture' };
function receipt(id: string) {
  return {
    type: 'custom_message', customType: 'collab-prompt', id, parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z', display: true,
    content: [
      { type: 'text', text: 'Caption 🖼️ 漢字' },
      { type: 'image', data: 'blob:sha256:0123456789abcdef', mimeType: 'image/png' },
    ],
    details: { from: 'Telegram @fixture_bot' },
  };
}
function fixture(t: TestContext, lines: unknown[], trailingNewline = true) {
  const directory = mkdtempSync(join(tmpdir(), 'omp-prompt-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'history.jsonl');
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + (trailingNewline ? '\n' : ''));
  return { sessionId: 'session-a', path };
}

test('canonical lookup uses exact entry ID and retains blob references unchanged', t => {
  const wanted = receipt('wanted');
  const source = fixture(t, [header, receipt('wanted-prefix'), wanted, receipt('later')]);
  assert.deepEqual(readPromptReceipt(source, 'wanted'), wanted);
});

test('title slot is allowed but session header identity must match', t => {
  const title = { type: 'title', v: 1, title: 'Fixture' };
  const wanted = receipt('wanted');
  const source = fixture(t, [title, header, wanted]);
  assert.deepEqual(readPromptReceipt(source, 'wanted'), wanted);
  assert.throws(() => readPromptReceipt({ ...source, sessionId: 'other-session' }, 'wanted'), /header.*other-session/);
});

test('missing entry and entry kinds other than collab-prompt fail explicitly', t => {
  const source = fixture(t, [header, receipt('other')]);
  assert.throws(() => readPromptReceipt(source, 'missing'), /missing.*not found/);
  for (const wrong of [
    { ...receipt('wrong'), type: 'message' },
    { ...receipt('wrong'), customType: 'other-custom-message' },
  ]) {
    writeFileSync(source.path, `${JSON.stringify(header)}\n${JSON.stringify(wrong)}\n`);
    assert.throws(() => readPromptReceipt(source, 'wrong'), /wrong.*not a collab-prompt custom_message/);
  }
});

test('chunk boundaries preserve split UTF-8 and long lines without a final newline', t => {
  const prefix = JSON.stringify(header) + '\n';
  const padding = 'x'.repeat(64 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength('{"padding":"') - 1);
  const longEntry = { padding: `${padding}🖼漢字`, ...receipt('long') };
  const source = fixture(t, [header, longEntry], false);
  assert.deepEqual(readPromptReceipt(source, 'long'), longEntry);
});

test('filesystem and JSON parse failures retain their original diagnostics', t => {
  const source = fixture(t, [header]);
  const missingPath = join(source.path, 'missing');
  assert.throws(() => readPromptReceipt({ ...source, path: missingPath }, 'wanted'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOTDIR');
  const malformed = '{invalid JSON';
  writeFileSync(source.path, `${JSON.stringify(header)}\n${malformed}\n`);
  let original: unknown;
  try { JSON.parse(malformed); } catch (error) { original = error; }
  assert.throws(() => readPromptReceipt(source, 'wanted'),
    (error: unknown) => error instanceof SyntaxError && original instanceof SyntaxError && error.message === original.message);
});

test('lookup stops at the matching entry without parsing subsequent history', t => {
  const wanted = receipt('wanted');
  const source = fixture(t, [header, wanted]);
  writeFileSync(source.path, `${JSON.stringify(header)}\n${JSON.stringify(wanted)}\n{invalid tail`);
  assert.deepEqual(readPromptReceipt(source, 'wanted'), wanted);
});
