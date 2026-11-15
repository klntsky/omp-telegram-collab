import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PendingPromptContent } from '../shared/contracts.js';
import { Store } from '../src/store.js';

const key = { botId: 1, chatId: -100, threadId: 17, instanceId: 1, cwd: '/work/project' };
const content: PendingPromptContent = {
  text: 'Expanded skill instructions\nPrompt',
  images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  documents: [{ fileId: 'telegram-file', fileName: 'notes.txt' }],
};

test('prompt queue is FIFO per session and duplicate admission preserves the original prompt', () => {
  const store = new Store(':memory:');
  try {
    const first = store.createSession(key, 'First');
    const second = store.createSession({ ...key, threadId: 18 }, 'Second');
    assert.equal(store.promptQueue.has(first.id), false);
    const firstId = store.promptQueue.enqueue(first.id, 90, 42, 43, content);
    const otherId = store.promptQueue.enqueue(second.id, 90, 44, 45, { text: 'Other session' });
    const lastId = store.promptQueue.enqueue(first.id, 2, 46, 47, { text: 'Last' });
    assert.equal(store.promptQueue.enqueue(first.id, 90, 99, 100, { text: 'Duplicate' }), firstId);
    assert.deepEqual(store.promptQueue.list(first.id), [
      { id: firstId, sessionId: first.id, messageId: 90, userId: 42, authorityUserId: 43, content },
      { id: lastId, sessionId: first.id, messageId: 2, userId: 46, authorityUserId: 47, content: { text: 'Last' } },
    ]);
    assert.equal(store.promptQueue.has(first.id), true);
    assert.equal(store.promptQueue.list(second.id)[0]!.id, otherId);
    store.promptQueue.replaceContent(firstId, { ...content, text: 'Prepared documents', documents: [] });
    assert.deepEqual(store.promptQueue.list(first.id)[0]!.content, { ...content, text: 'Prepared documents', documents: [] });
    store.promptQueue.remove(firstId);
    store.promptQueue.remove(firstId);
    assert.deepEqual(store.promptQueue.list(first.id).map(prompt => prompt.id), [lastId]);
    store.promptQueue.remove(lastId);
    assert.equal(store.promptQueue.has(first.id), false);
    assert.equal(store.promptQueue.has(second.id), true);
  } finally {
    store.close();
  }
});

test('prompt queue preserves full pending attachments and removals across disk reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-prompt-queue-'));
  const filename = join(directory, 'topics.sqlite');
  try {
    const first = new Store(filename);
    let sessionId: string;
    let id: number;
    try {
      sessionId = first.createSession(key, 'Session').id;
      id = first.promptQueue.enqueue(sessionId, 7, 42, 43, content);
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.deepEqual(second.promptQueue.list(sessionId), [{ id, sessionId, messageId: 7, userId: 42, authorityUserId: 43, content }]);
      second.promptQueue.replaceContent(id, { text: 'Downloaded document text', images: content.images });
    } finally {
      second.close();
    }
    const third = new Store(filename);
    try {
      assert.deepEqual(third.promptQueue.list(sessionId)[0]!.content, { text: 'Downloaded document text', images: content.images });
      third.promptQueue.remove(id);
    } finally {
      third.close();
    }
    const fourth = new Store(filename);
    try {
      assert.equal(fourth.promptQueue.has(sessionId), false);
    } finally {
      fourth.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('queue initialization adds its table to existing current databases without resetting data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-prompt-queue-schema-'));
  const filename = join(directory, 'topics.sqlite');
  try {
    const first = new Store(filename);
    let sessionId: string;
    try {
      sessionId = first.createSession(key, 'Retained session').id;
      first.addPendingSkill({ botId: 1, destination: { kind: 'general', chatId: -100 }, userId: 42 }, 'retained-skill');
      first.db.exec('DROP TABLE prompt_queue');
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.equal(second.getSession(sessionId)?.name, 'Retained session');
      assert.equal(Number(second.db.prepare('PRAGMA user_version').get()!.user_version), 8);
      assert.deepEqual(second.getPendingSkills({ botId: 1, destination: { kind: 'general', chatId: -100 }, userId: 42 }), ['retained-skill']);
      second.promptQueue.enqueue(sessionId, 7, 42, 43, content);
      assert.equal(second.promptQueue.has(sessionId), true);
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session closure, detachment, and deletion cancel queued prompts without affecting other sessions', () => {
  const store = new Store(':memory:');
  try {
    const closed = store.createSession(key, 'Closed');
    const detached = store.createSession({ ...key, threadId: 18 }, 'Detached');
    const deleted = store.createSession({ ...key, threadId: 19 }, 'Deleted');
    const retained = store.createSession({ ...key, threadId: 20 }, 'Retained');
    for (const session of [closed, detached, deleted, retained]) store.promptQueue.enqueue(session.id, 7, 42, 43, content);
    store.updateSession(closed.id, { status: 'closed' });
    store.updateSession(closed.id, { status: 'open' });
    assert.equal(store.promptQueue.has(closed.id), false);
    store.detachTopic({ botId: 1, chatId: -100, threadId: 18 });
    assert.equal(store.promptQueue.has(detached.id), false);
    store.db.prepare('DELETE FROM session_pending_titles WHERE session_id=?').run(deleted.id);
    store.db.prepare('DELETE FROM sessions WHERE id=?').run(deleted.id);
    assert.equal(store.promptQueue.has(deleted.id), false);
    assert.equal(store.promptQueue.has(retained.id), true);
    assert.throws(() => store.promptQueue.enqueue(deleted.id, 8, 42, 43, content), /FOREIGN KEY/);
    store.cancelInitialTask(retained.id);
    assert.equal(store.promptQueue.has(retained.id), false);
    store.promptQueue.enqueue(retained.id, 8, 42, 43, content);
    store.updateSession(retained.id, { status: 'detached' });
    assert.equal(store.promptQueue.has(retained.id), false);
  } finally {
    store.close();
  }
});
