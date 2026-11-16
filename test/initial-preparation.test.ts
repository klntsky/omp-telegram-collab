import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

function pending(store: Store, threadId: number, botId = 1, preparation: 'topic' | 'fork' = 'topic') {
  return store.createSession({ botId, chatId: -100, threadId, instanceId: 1, cwd: '/project' }, 'Preparation', undefined, {
    prompt: { messageId: 1, userId: 7, authorityUserId: 8, content: { text: `Task ${threadId}` } },
    preparation,
  });
}

test('session preparation persists across readers until bot-scoped recovery detaches interrupted forks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-preparation-'));
  const filename = join(directory, 'store.sqlite');
  try {
    const original = new Store(filename);
    let first: string;
    let fork: string;
    let otherBot: string;
    try {
      first = pending(original, 10).id;
      fork = pending(original, 11, 1, 'fork').id;
      otherBot = pending(original, 10, 2).id;
      const reader = new Store(filename);
      try {
        assert.equal(reader.isSessionPreparing(first), true);
        assert.throws(() => reader.beginSessionPreparation(first), /UNIQUE constraint failed/);
        assert.equal(original.isSessionPreparing(first), true);
      } finally { reader.close(); }
    } finally { original.close(); }
    const reopened = new Store(filename);
    try {
      assert.equal(reopened.isSessionPreparing(first!), true);
      reopened.recoverSessionPreparations(999);
      assert.equal(reopened.isSessionPreparing(first!), true);
      reopened.recoverSessionPreparations(1);
      assert.equal(reopened.isSessionPreparing(first!), false);
      assert.equal(reopened.promptQueue.has(first!), true);
      assert.equal(reopened.getSession(fork!)?.status, 'detached');
      assert.equal(reopened.promptQueue.has(fork!), false);
      assert.equal(reopened.isSessionPreparing(otherBot!), true);
      reopened.recoverSessionPreparations(2);
      assert.equal(reopened.isSessionPreparing(otherBot!), false);
      assert.equal(reopened.promptQueue.has(otherBot!), true);
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pending document preparation checkpoints survive reopen on the same queue item', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'queued-document-'));
  const filename = join(directory, 'store.sqlite');
  const content = { text: 'Complete the pending document task', documents: [{ fileId: 'telegram-document-file-id', fileName: 'pending-upload.txt' }] };
  try {
    const original = new Store(filename);
    let id: string;
    let promptId: number;
    try {
      id = original.createSession({ botId: 1, chatId: -100, threadId: 10, instanceId: 1, cwd: '/project' }, 'Pending document', undefined, {
        prompt: { messageId: 90, userId: 7, authorityUserId: 8, content, preparation: { automaticWorktree: true, extensions: [{kind:'worktree'}] } },
      }).id;
      promptId = original.promptQueue.first(id)!.id;
      original.promptQueue.replacePreparation(promptId, { automaticWorktree: false, extensions: [] });
    } finally { original.close(); }
    const reopened = new Store(filename);
    try {
      const queued = reopened.promptQueue.first(id!)!;
      assert.equal(queued.id, promptId!);
      assert.equal(queued.authorityUserId, 8);
      assert.deepEqual(queued.content, content);
      assert.deepEqual(queued.preparation, { automaticWorktree: false, extensions: [] });
      const prepared = { text: `${content.text}\n\nDocument saved to /project/pending-upload.txt` };
      reopened.promptQueue.replaceContent(queued.id, prepared);
      assert.deepEqual(reopened.promptQueue.first(id!)?.content, prepared);
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
