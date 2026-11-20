import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { readReplyHistory } from '../src/bot/reply-history.js';

const sessionId = 'reply-history-session';
const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: '/work' });

function entry(id: string): SessionEntry {
  return {
    type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'assistant', content: [{ type: 'text', text: id }], model: 'fixture', timestamp: 0, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    },
  };
}

async function fixture(t: TestContext, records: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reply-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { sessionId, path: path.join(directory, 'session.jsonl') };
  await writeFile(source.path, `${header}\n${records}`);
  return source;
}

test('reply history rejects a different native session identity', async t => {
  const committed = entry('committed');
  const source = await fixture(t, `${JSON.stringify(committed)}\n`);
  await assert.rejects(readReplyHistory({ ...source, sessionId: 'different-session' }), { name: 'Error' });
  assert.deepEqual(await readReplyHistory(source), [committed]);
});

test('malformed committed JSON retains the original parser diagnostic', async t => {
  const malformed = '{"type":"message","id": invalid}';
  const source = await fixture(t, `${JSON.stringify(entry('before-corruption'))}\n${malformed}\n`);
  let original: unknown;
  try { JSON.parse(malformed); } catch (error) { original = error; }
  assert.ok(original instanceof SyntaxError);
  const diagnostic = original.message;
  await assert.rejects(readReplyHistory(source), error => {
    assert.ok(error instanceof SyntaxError);
    assert.equal(error.message, diagnostic);
    return true;
  });
});

test('an incomplete last record is ignored until its newline is committed', async t => {
  const committed = entry('committed');
  const pending = entry('pending');
  const pendingLine = JSON.stringify(pending);
  const split = pendingLine.indexOf(':') + 1;
  const source = await fixture(t, `${JSON.stringify(committed)}\n${pendingLine.slice(0, split)}`);
  assert.deepEqual(await readReplyHistory(source), [committed]);
  await appendFile(source.path, pendingLine.slice(split));
  assert.deepEqual(await readReplyHistory(source), [committed]);
  await appendFile(source.path, '\n');
  assert.deepEqual(await readReplyHistory(source), [committed, pending]);
});
