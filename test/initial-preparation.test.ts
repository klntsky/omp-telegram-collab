import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

function pending(store: Store, threadId: number, botId = 1) {
  return store.createSession({ botId, chatId: -100, threadId, instancePath: '/project' }, 'Preparation', { kind: 'managed' }, { text: `Task ${threadId}` });
}

test('initial preparation blocks admission without hiding pending work and releases exactly one claim', () => {
  const store = new Store(':memory:');
  try {
    const gated = pending(store, 10);
    const other = pending(store, 11);
    store.beginInitialTaskPreparation(gated.id);
    assert.throws(() => store.beginInitialTaskPreparation(gated.id), /UNIQUE constraint failed/);
    assert.equal(store.hasPendingInitialTask(gated.id), true);
    assert.equal(store.claimInitialTask(gated.id), undefined);
    assert.equal(store.hasPendingInitialTask(gated.id), true);
    assert.deepEqual(store.claimInitialTask(other.id), { text: 'Task 11' });
    store.finishInitialTaskPreparation(other.id);
    assert.equal(store.claimInitialTask(gated.id), undefined);
    store.finishInitialTaskPreparation(gated.id);
    assert.deepEqual(store.claimInitialTask(gated.id), { text: 'Task 10' });
    assert.equal(store.claimInitialTask(gated.id), undefined);
    assert.equal(store.hasPendingInitialTask(gated.id), false);
  } finally { store.close(); }
});

test('initial preparation cancellation survives both normal release and recovery', () => {
  const store = new Store(':memory:');
  try {
    for (const recover of [false, true]) {
      const session = pending(store, recover ? 11 : 10);
      store.beginInitialTaskPreparation(session.id);
      store.cancelInitialTask(session.id);
      assert.equal(store.hasPendingInitialTask(session.id), false);
      if (recover) store.recoverInitialTaskPreparations(session.botId);
      else store.finishInitialTaskPreparation(session.id);
      assert.equal(store.claimInitialTask(session.id), undefined);
      assert.equal(store.db.prepare('SELECT initial_state FROM sessions WHERE id=?').get(session.id)!.initial_state, 'cancelled');
    }
  } finally { store.close(); }
});

test('initial preparation persists across disk reopen and concurrent readers until bot-scoped recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'initial-preparation-'));
  const filename = join(directory, 'store.sqlite');
  try {
    const original = new Store(filename);
    let first: string;
    let sameBot: string;
    let otherBot: string;
    let submitted: string;
    try {
      first = pending(original, 10).id;
      sameBot = pending(original, 11).id;
      otherBot = pending(original, 10, 2).id;
      submitted = pending(original, 12).id;
      assert.deepEqual(original.claimInitialTask(submitted), { text: 'Task 12' });
      for (const id of [first, sameBot, otherBot, submitted]) original.beginInitialTaskPreparation(id);
      const reader = new Store(filename);
      try {
        assert.equal(reader.claimInitialTask(first), undefined);
        assert.throws(() => reader.beginInitialTaskPreparation(first), /UNIQUE constraint failed/);
        assert.equal(original.claimInitialTask(first), undefined);
      } finally { reader.close(); }
    } finally { original.close(); }
    const reopened = new Store(filename);
    try {
      for (const id of [first!, sameBot!, otherBot!]) {
        assert.equal(reopened.hasPendingInitialTask(id), true);
        assert.equal(reopened.claimInitialTask(id), undefined);
      }
      reopened.recoverInitialTaskPreparations(999);
      assert.equal(reopened.claimInitialTask(first!), undefined);
      reopened.recoverInitialTaskPreparations(1);
      assert.deepEqual(reopened.claimInitialTask(first!), { text: 'Task 10' });
      assert.deepEqual(reopened.claimInitialTask(sameBot!), { text: 'Task 11' });
      assert.equal(reopened.claimInitialTask(first!), undefined);
      assert.equal(reopened.claimInitialTask(submitted!), undefined);
      assert.equal(reopened.claimInitialTask(otherBot!), undefined);
      assert.equal(reopened.hasPendingInitialTask(otherBot!), true);
      reopened.recoverInitialTaskPreparations(2);
      assert.deepEqual(reopened.claimInitialTask(otherBot!), { text: 'Task 10' });
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
