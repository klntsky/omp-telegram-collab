import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { openVersionOneDatabase } from './schema-v1.js';

const message = { text: 'historical answer', timestamp: 123 };
const fingerprint = createHash('sha256').update(JSON.stringify([message.timestamp, message.text])).digest('hex');

async function legacy(version: number, run: (store: Store, filename: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-migration-'));
  const filename = join(directory, 'store.sqlite');
  try {
    const db = openVersionOneDatabase(filename);
    for (const [id, thread] of [['local', 2], ['other', 3]] as const)
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, 1, -10, thread, '/project', id, 'open', JSON.stringify({kind:'managed'}), 1, null, null);
    db.prepare('INSERT INTO prompt_submissions VALUES (?,?,?,?,?,?,?)').run(7, 'local', 'sender', 71, 'pending text', 'pending-hash', 'pending');
    db.prepare('INSERT INTO prompt_submissions VALUES (?,?,?,?,?,?,?)').run(8, 'local', 'sender', 72, 'uncertain text', 'uncertain-hash', 'uncertain');
    db.prepare('INSERT INTO prompt_submissions VALUES (?,?,?,?,?,?,?)').run(9, 'local', 'sender', 73, 'ambiguous text', 'ambiguous-hash', 'ambiguous');
    db.prepare('INSERT INTO prompt_submissions VALUES (?,?,?,?,?,?,?)').run(100, 'other', 'sender', 74, 'deleted', 'deleted-hash', 'pending');
    db.exec('DELETE FROM prompt_submissions WHERE id=100');
    db.prepare('INSERT INTO prompt_receipts VALUES (?,?,?)').run('local', 'old-prompt', 70);
    db.prepare('INSERT INTO replies VALUES (?,?,?)').run('local', fingerprint, 456);
    db.prepare('INSERT INTO session_pending_titles VALUES (?,?)').run('local', 'retained title');
    db.prepare('INSERT INTO session_pending_close_icons VALUES (?)').run('local');
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    const store = new Store(filename);
    try { run(store, filename); } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const version of [0, 1]) {
  test(`anchor migration schema ${version} stages provenance without inventing namespaces and preserves allocator and tasks`, async () => {
    await legacy(version, (store, filename) => {
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 3);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM prompt_submissions').get()!.n, 0);
      assert.equal(store.db.prepare('SELECT omp_session_id FROM provenance_upgrades WHERE session_id=?').get('local')!.omp_session_id, null);
      assert.deepEqual(store.db.prepare('SELECT id,state FROM pending_upgrade_prompt_submissions ORDER BY id').all().map(row => ({...row})), [
        {id: 7, state: 'pending'}, {id: 8, state: 'uncertain'}, {id: 9, state: 'ambiguous'},
      ]);
      assert.equal(store.db.prepare('SELECT created_at FROM pending_upgrade_replies').get()!.created_at, 456);
      assert.equal(store.db.prepare('SELECT title FROM session_pending_titles').get()!.title, 'retained title');
      assert.ok(store.db.prepare('SELECT 1 FROM session_pending_close_icons').get());
      const newId = store.recordPromptSubmission('other', 'native-other', 'sender', {text: 'new'}, 80);
      assert.ok(newId > 100);
      assert.equal(store.beginPromptReceiptSnapshot('local', 'native'), 9);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pending_upgrade_prompt_submissions').get()!.n, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pending_upgrade_prompt_receipts').get()!.n, 0);
      assert.deepEqual(store.db.prepare('SELECT id,state,omp_session_id FROM prompt_submissions WHERE session_id=? ORDER BY id').all('local').map(row => ({...row})), [
        {id: 7, state: 'uncertain', omp_session_id: 'native'}, {id: 8, state: 'uncertain', omp_session_id: 'native'}, {id: 9, state: 'ambiguous', omp_session_id: 'native'},
      ]);
      assert.equal(store.beginPromptReceiptSnapshot('local', 'native'), 9);
      assert.equal(store.beginPromptReceiptSnapshot('local', 'different-native'), 0);
      assert.equal(store.db.prepare('SELECT omp_session_id FROM provenance_upgrades WHERE session_id=?').get('local')!.omp_session_id, 'native');
      const reopened = new Store(filename);
      try { assert.equal(reopened.beginPromptReceiptSnapshot('local', 'native'), 9); }
      finally { reopened.close(); }
    });
  });
}

test('anchor migration historical fingerprints suppress every matching snapshot but never a distinct live reply or another native session', async () => {
  await legacy(1, store => {
    store.beginPromptReceiptSnapshot('local', 'native');
    assert.equal(store.rememberSnapshotReply('local', 'native', 'entry-a', message), false);
    assert.equal(store.rememberSnapshotReply('local', 'native', 'entry-b', message), false);
    assert.equal(store.rememberReply('local', 'native', 'entry-a'), false);
    assert.equal(store.rememberReply('local', 'native', 'live-a'), true);
    assert.equal(store.rememberReply('local', 'native', 'live-b'), true);
    assert.equal(store.rememberSnapshotReply('local', 'other-native', 'entry-a', message), true);
    assert.equal(store.rememberSnapshotReply('local', 'native', 'new-entry', {...message, text: 'new answer'}), true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_anchors').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pending_upgrade_replies').get()!.n, 1);
  });
});

test('anchor migration adopted receipts anchor only on observed real parents without consuming another submission', async () => {
  await legacy(1, store => {
    const boundary = store.beginPromptReceiptSnapshot('local', 'native');
    assert.equal(store.getMessageAnchor('local', 'native', -10, 70), undefined);
    const anchor = {ompSessionId: 'native', entryId: 'old-prompt', parentEntryId: 'real-parent'};
    assert.deepEqual(store.recordPromptReceipt('local', anchor, 'sender', {text: 'pending text'}, boundary), {fresh: false, messageId: 70});
    assert.deepEqual(store.getMessageAnchor('local', 'native', -10, 70), {...anchor, kind: 'collab-prompt', partIndex: 0});
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM prompt_submissions WHERE session_id=?').get('local')!.n, 3);
    assert.throws(() => store.recordPromptReceipt('local', {...anchor, parentEntryId: 'conflict'}, 'sender', {text: 'pending text'}, boundary));
    assert.equal(store.getMessageAnchor('local', 'native', -10, 70)!.parentEntryId, 'real-parent');
    const unknown = {...anchor, entryId: 'unknown'};
    assert.deepEqual(store.recordPromptReceipt('local', unknown, undefined, {text: 'unknown'}, boundary), {fresh: true});
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_anchors').get()!.n, 1);
  });
});

test('anchor migration conflicting adoption rolls back binding, copies, deletion, and pending boundary updates', async () => {
  await legacy(1, store => {
    store.db.prepare('INSERT INTO prompt_submissions VALUES (?,?,?,?,?,?,?,?)').run(7, 'other', 'native-other', 'sender', 90, 'collision', 'hash', 'pending');
    assert.throws(() => store.beginPromptReceiptSnapshot('local', 'native'));
    assert.equal(store.db.prepare('SELECT omp_session_id FROM provenance_upgrades WHERE session_id=?').get('local')!.omp_session_id, null);
    assert.equal(store.db.prepare('SELECT state FROM pending_upgrade_prompt_submissions WHERE id=7').get()!.state, 'pending');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pending_upgrade_prompt_receipts').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM prompt_receipts').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM prompt_submissions').get()!.n, 1);
  });
});

test('anchor migration adopted uncertain duplicates stay ambiguous rather than inventing receipt anchors', async () => {
  await legacy(1, store => {
    store.db.prepare('UPDATE pending_upgrade_prompt_submissions SET text=? WHERE id IN (7,8)').run('duplicate');
    const boundary = store.beginPromptReceiptSnapshot('local', 'native');
    const result = store.recordPromptReceipt('local', {ompSessionId: 'native', entryId: 'duplicate-entry', parentEntryId: null}, 'sender', {text: 'duplicate'}, boundary);
    assert.deepEqual(result, {fresh: true});
    assert.equal(store.db.prepare('SELECT state FROM prompt_submissions WHERE id=8').get()!.state, 'ambiguous');
    assert.equal(store.db.prepare('SELECT state FROM prompt_submissions WHERE id=9').get()!.state, 'ambiguous');
    assert.equal(store.db.prepare('SELECT message_id FROM prompt_receipts WHERE entry_id=?').get('duplicate-entry')!.message_id, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_anchors').get()!.n, 0);
  });
});
