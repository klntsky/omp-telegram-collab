import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PendingPromptContent } from '../shared/contracts.js';
import { Store } from '../src/store.js';
import { initializeDatabase } from '../src/migrations.js';

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
    assert.equal(store.promptQueue.enqueue(first.id, 90, 99, 100, { text: 'After removal' }), firstId);
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
    let cancelledId: number;
    try {
      sessionId = first.createSession(key, 'Session').id;
      id = first.promptQueue.enqueue(sessionId, 7, 42, 43, content, { skills: ['review'], extensions: [{ kind: 'worktree' }] });
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.deepEqual(second.promptQueue.list(sessionId), [{
        id, sessionId, messageId: 7, userId: 42, authorityUserId: 43, content,
        preparation: { skills: ['review'], extensions: [{ kind: 'worktree' }] },
      }]);
      second.promptQueue.replacePreparation(id, { skills: [], extensions: [], preset: 'selected' });
      second.promptQueue.replaceContent(id, { text: 'Downloaded document text', images: content.images });
    } finally {
      second.close();
    }
    const third = new Store(filename);
    try {
      assert.deepEqual(third.promptQueue.list(sessionId)[0]!.content, { text: 'Downloaded document text', images: content.images });
      assert.deepEqual(third.promptQueue.list(sessionId)[0]!.preparation, { skills: [], extensions: [], preset: 'selected' });
      third.promptQueue.remove(id);
      cancelledId = third.promptQueue.enqueue(sessionId, 8, 42, 43, content);
      third.updateSession(sessionId, { status: 'closed' });
      third.updateSession(sessionId, { status: 'open' });
    } finally {
      third.close();
    }
    const fourth = new Store(filename);
    try {
      assert.equal(fourth.promptQueue.has(sessionId), false);
      assert.equal(fourth.promptQueue.enqueue(sessionId, 7, 99, 100, content), id);
      assert.deepEqual(fourth.promptQueue.list(sessionId), []);
      assert.equal(fourth.db.prepare('SELECT COUNT(*) AS count FROM prompt_queue_preparations').get()!.count, 0);
      assert.equal(fourth.promptQueue.enqueue(sessionId, 8, 42, 43, content), cancelledId);
      assert.deepEqual(fourth.promptQueue.list(sessionId), []);
      const admission = fourth.db.prepare('SELECT session_id,message_id FROM prompt_admissions WHERE id=?').get(id)!;
      assert.equal(admission.session_id, sessionId);
      assert.equal(admission.message_id, 7);
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
      first.db.exec('DROP TABLE prompt_queue_preparations; DROP TABLE prompt_queue; DROP TABLE prompt_admissions');
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.equal(second.getSession(sessionId)?.name, 'Retained session');
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

test('additive admission initialization retains existing pending ids and prevents their replay', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(key, 'Existing queue');
    const id = store.promptQueue.enqueue(session.id, 7, 42, 43, content);
    store.db.exec('DROP TABLE prompt_admissions');
    initializeDatabase(store.db);
    assert.equal(store.promptQueue.enqueue(session.id, 7, 99, 100, { text: 'Duplicate' }), id);
    assert.deepEqual(store.promptQueue.list(session.id)[0]!.content, content);
    store.promptQueue.remove(id);
    assert.equal(store.promptQueue.enqueue(session.id, 7, 99, 100, content), id);
    assert.deepEqual(store.promptQueue.list(session.id), []);
    assert.ok(store.promptQueue.enqueue(session.id, 8, 42, 43, content) > id);
    const cancelledId = store.promptQueue.list(session.id)[0]!.id;
    assert.equal(store.promptQueue.contains(cancelledId), true);
    store.promptQueue.cancel(session.id);
    assert.equal(store.promptQueue.contains(cancelledId), false);
    assert.equal(store.promptQueue.enqueue(session.id, 8, 42, 43, content), cancelledId);
    assert.deepEqual(store.promptQueue.list(session.id), []);
  } finally {
    store.close();
  }
});

test('session closure, detachment, and deletion cancel queued prompts without affecting other sessions', () => {
  const store = new Store(':memory:');
  try {
    const closed = store.createSession(key, 'Closed');
    const detached = store.createSession({ ...key, threadId: 18 }, 'Detached');
    const deleted = store.createSession({ ...key, threadId: 19 }, 'Deleted');
    const retained = store.createSession({ ...key, threadId: 20 }, 'Retained');
    const ids = new Map([closed, detached, deleted, retained].map(session =>
      [session.id, store.promptQueue.enqueue(session.id, 7, 42, 43, content)]));
    store.updateSession(closed.id, { status: 'closed' });
    store.updateSession(closed.id, { status: 'open' });
    assert.equal(store.promptQueue.has(closed.id), false);
    assert.equal(store.promptQueue.enqueue(closed.id, 7, 42, 43, content), ids.get(closed.id));
    assert.equal(store.promptQueue.has(closed.id), false);
    store.detachTopic({ botId: 1, chatId: -100, threadId: 18 });
    assert.equal(store.promptQueue.has(detached.id), false);
    assert.equal(store.promptQueue.enqueue(detached.id, 7, 42, 43, content), ids.get(detached.id));
    assert.equal(store.promptQueue.has(detached.id), false);
    store.db.prepare('DELETE FROM session_pending_titles WHERE session_id=?').run(deleted.id);
    store.db.prepare('DELETE FROM sessions WHERE id=?').run(deleted.id);
    assert.equal(store.promptQueue.has(deleted.id), false);
    assert.equal(store.promptQueue.enqueue(deleted.id, 7, 42, 43, content), ids.get(deleted.id));
    assert.equal(store.promptQueue.has(deleted.id), false);
    assert.equal(store.promptQueue.has(retained.id), true);
    assert.throws(() => store.promptQueue.enqueue(deleted.id, 8, 42, 43, content), /FOREIGN KEY/);
    assert.equal(store.db.prepare('SELECT 1 FROM prompt_admissions WHERE session_id=? AND message_id=8').get(deleted.id), undefined);
    store.promptQueue.cancel(retained.id);
    assert.equal(store.promptQueue.has(retained.id), false);
    store.promptQueue.enqueue(retained.id, 8, 42, 43, content);
    store.updateSession(retained.id, { status: 'detached' });
    assert.equal(store.promptQueue.has(retained.id), false);
  } finally {
    store.close();
  }
});

test('admission consumes selected skills atomically and redelivery preserves newer selections', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(key, 'Session');
    const selection = { botId: 1, destination: {kind: 'topic' as const, chatId: key.chatId, threadId: key.threadId}, userId: 42 };
    store.addPendingSkill(selection, 'original');
    const admitted = store.promptQueue.enqueue(session.id, 7, 42, 43, content, undefined,
      () => store.clearPendingSkills(selection));
    assert.deepEqual(store.getPendingSkills(selection), []);
    store.promptQueue.remove(admitted);
    store.addPendingSkill(selection, 'next-prompt');
    store.promptQueue.enqueue(session.id, 7, 42, 43, content, undefined,
      () => store.clearPendingSkills(selection));
    assert.deepEqual(store.getPendingSkills(selection), ['next-prompt']);
    assert.equal(store.promptQueue.has(session.id), false);
    const failure = new Error('Admission metadata write failed');
    assert.throws(() => store.promptQueue.enqueue(session.id, 8, 42, 43, content, undefined, () => {
      store.clearPendingSkills(selection);
      throw failure;
    }), error => error === failure);
    assert.deepEqual(store.getPendingSkills(selection), ['next-prompt']);
    assert.equal(store.promptQueue.has(session.id), false);
    store.promptQueue.enqueue(session.id, 8, 42, 43, content);
    assert.equal(store.promptQueue.list(session.id)[0]?.messageId, 8);
  } finally {
    store.close();
  }
});
