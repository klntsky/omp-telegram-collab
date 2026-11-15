import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

function pending(store: Store, threadId: number, botId = 1) {
  return store.createSession({ botId, chatId: -100, threadId, instanceId: 1, cwd: '/project' }, 'Preparation', { kind: 'managed' }, { text: `Task ${threadId}` });
}


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

test('capacity-blocked initial document survives disk reopen until preparation and claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'initial-document-'));
  const filename = join(directory, 'store.sqlite');
  const content = {
    text: 'Complete the pending document task',
    documents: [{ fileId: 'telegram-document-file-id', fileName: 'pending-upload.txt' }],
  };
  try {
    const original = new Store(filename);
    let id: string;
    try {
      id = original.createSession(
        { botId: 1, chatId: -100, threadId: 10, instanceId: 1, cwd: '/project' },
        'Pending document', { kind: 'managed' }, content, 7,
      ).id;
      assert.deepEqual(original.getPendingInitialTask(id), content);
    } finally { original.close(); }
    const reopened = new Store(filename);
    try {
      reopened.recoverInitialTaskPreparations(1);
      assert.equal(reopened.hasPendingInitialTask(id!), true);
      assert.equal(reopened.getInitialAuthority(id!), 7);
      assert.deepEqual(reopened.getPendingInitialTask(id!), content);
      reopened.beginInitialTaskPreparation(id!);
      assert.equal(reopened.claimInitialTask(id!), undefined);
      assert.equal(reopened.getPendingInitialTask(id!), undefined);
      const prepared = { text: `${content.text}\n\nDocument saved to /project/pending-upload.txt` };
      reopened.replacePendingInitialTask(id!, prepared);
      reopened.finishInitialTaskPreparation(id!);
      assert.deepEqual(reopened.claimInitialTask(id!), prepared);
      assert.equal(reopened.hasPendingInitialTask(id!), false);
      assert.equal(reopened.getPendingInitialTask(id!), undefined);
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
