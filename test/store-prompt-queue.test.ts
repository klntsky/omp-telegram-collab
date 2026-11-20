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
      { id: firstId, sessionId: first.id, messageId: 90, userId: 42, authorityUserId: 43, content, state: 'pending', availableAt: 0, attempts: 0 },
      { id: lastId, sessionId: first.id, messageId: 2, userId: 46, authorityUserId: 47, content: { text: 'Last' }, state: 'pending', availableAt: 0, attempts: 0 },
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
        state: 'pending', availableAt: 0, attempts: 0,
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

test('cancelling one queued task preserves independently authorized queued prompts', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(key, 'Session', undefined, {prompt:{messageId:6,userId:42,authorityUserId:42,content:{text:'Initial task'}}});
    const first = store.promptQueue.first(session.id)!;
    store.promptQueue.enqueue(session.id, 7, 43, 43, content);
    const pending = store.promptQueue.list(session.id).slice(1);
    store.promptQueue.remove(first.id);
    assert.equal(store.promptQueue.contains(first.id), false);
    assert.deepEqual(store.promptQueue.list(session.id), pending);
    assert.equal(store.getSession(session.id)?.status, 'open');
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

test('session creation admits its prompt and consumes skills atomically only once', () => {
  const store = new Store(':memory:');
  const selection = { botId: 1, destination: {kind: 'topic' as const, chatId: key.chatId, threadId: key.threadId}, userId: 42 };
  const prompt = { messageId: 7, userId: 42, authorityUserId: 43, content };
  try {
    store.addPendingSkill(selection, 'selected');
    const failure = new Error('Session admission failed');
    assert.throws(() => store.createSession(key, 'Session', undefined, {
      prompt, preparation: 'topic', onAdmitted: () => {
        store.clearPendingSkills(selection);
        throw failure;
      },
    }), error => error === failure);
    assert.equal(store.getTopic({botId: key.botId, destination: selection.destination}), undefined);
    assert.deepEqual(store.getPendingSkills(selection), ['selected']);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM prompt_admissions').get()!.count, 0);
    const options = { prompt, preparation: 'topic' as const, onAdmitted: () => store.clearPendingSkills(selection) };
    const session = store.createSession(key, 'Session', undefined, options);
    assert.deepEqual(store.getPendingSkills(selection), []);
    assert.equal(store.isSessionPreparing(session.id), true);
    store.addPendingSkill(selection, 'next');
    assert.equal(store.createSession(key, 'Duplicate', undefined, options).id, session.id);
    assert.deepEqual(store.getPendingSkills(selection), ['next']);
    assert.equal(store.promptQueue.list(session.id).length, 1);
    store.createSession({...key, threadId:18}, 'Empty', undefined, {onAdmitted: () => { throw failure; }});
  } finally { store.close(); }
});

test('explicit startup rejection retains queued intent beyond acceptance deadlines with capped backoff', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(key, 'Retry');
    const id = store.promptQueue.enqueue(session.id, 1, 42, 43, content);
    store.promptQueue.markSubmitted(id, 101, 2000);
    assert.equal(store.promptQueue.first(session.id)?.state, 'submitted');
    assert.deepEqual(store.promptQueue.retryStartup(101, 100), { kind: 'retry', availableAt: 350 });
    assert.equal(store.promptQueue.first(session.id)?.attempts, 1);
    assert.equal(store.promptQueue.first(session.id)?.acceptanceDeadline, undefined);
    assert.deepEqual(store.promptQueue.retryStartup(101, 200), { kind: 'absent' });
    store.promptQueue.markSubmitted(id, 102, 9999);
    assert.equal(store.promptQueue.first(session.id)?.acceptanceDeadline, 9999);
    store.promptQueue.completeSubmission(101);
    assert.equal(store.promptQueue.contains(id), true);
    assert.deepEqual(store.promptQueue.retryStartup(102, 10000), { kind: 'retry', availableAt: 10500 });
    assert.equal(store.promptQueue.contains(id), true);
    assert.equal(store.promptQueue.enqueue(session.id, 1, 42, 43, content), id);
    assert.equal(store.promptQueue.first(session.id)?.state, 'pending');
    store.promptQueue.markSubmitted(id, 104, 20000);
    assert.equal(store.promptQueue.first(session.id)?.acceptanceDeadline, 20000);
    assert.deepEqual(store.promptQueue.retryStartup(104, 20001), { kind: 'retry', availableAt: 20751 });
    store.promptQueue.markSubmitted(id, 105, 30000);
    assert.deepEqual(store.promptQueue.retryStartup(105, 30001), { kind: 'retry', availableAt: 31001 });
    store.promptQueue.markSubmitted(id, 106, 40000);
    assert.deepEqual(store.promptQueue.retryStartup(106, 40001), { kind: 'retry', availableAt: 41001 });
    const cancelled = store.promptQueue.enqueue(session.id, 2, 42, 43, content);
    store.promptQueue.markSubmitted(cancelled, 103, 5000);
    store.promptQueue.cancel(session.id);
    assert.deepEqual(store.promptQueue.retryStartup(103, 100), { kind: 'absent' });
  } finally { store.close(); }
});

test('restart recovery consumes submitted rows without replay and preserves pending rows and other bots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-submission-recovery-'));
  const filename = join(directory, 'topics.sqlite');
  try {
    const original = new Store(filename);
    let sessionId: string;
    let otherSessionId: string;
    let submittedId: number;
    let submissionId: number;
    let pendingId: number;
    try {
      sessionId = original.createSession(key, 'Submitted').id;
      otherSessionId = original.createSession({ ...key, botId: 2 }, 'Other bot').id;
      submittedId = original.promptQueue.enqueue(sessionId, 1, 42, 43, {text:'Submitted'});
      submissionId = original.recordPromptSubmission(sessionId, 'omp-session', 'sender', {text:'Submitted'}, 1);
      original.promptQueue.markSubmitted(submittedId, submissionId, Date.now() + 10000);
      pendingId = original.promptQueue.enqueue(sessionId, 2, 42, 43, content);
      const otherId = original.promptQueue.enqueue(otherSessionId, 1, 42, 43, content);
      const otherSubmission = original.recordPromptSubmission(otherSessionId, 'other-session', 'sender', {text:content.text}, 1);
      original.promptQueue.markSubmitted(otherId, otherSubmission, Date.now() + 10000);
    } finally { original.close(); }
    const reopened = new Store(filename);
    try {
      assert.equal(reopened.promptQueue.first(sessionId!)?.state, 'submitted');
      reopened.promptQueue.recoverSubmissions(1);
      assert.equal(reopened.promptQueue.contains(submittedId!), false);
      assert.equal(reopened.promptQueue.first(sessionId!)?.id, pendingId!);
      assert.equal(reopened.promptQueue.first(otherSessionId!)?.state, 'submitted');
      assert.equal(reopened.db.prepare('SELECT state FROM prompt_submissions WHERE id=?').get(submissionId!)?.state, 'uncertain');
      assert.equal(reopened.promptQueue.enqueue(sessionId!, 1, 42, 43, content), submittedId!);
      assert.deepEqual(reopened.promptQueue.list(sessionId!).map(row => row.id), [pendingId!]);
      reopened.promptQueue.recoverSubmissions(1);
      assert.equal(reopened.promptQueue.first(sessionId!)?.id, pendingId!);
    } finally { reopened.close(); }
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('skill expansion rolls back with its checkpoint when persistence fails', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(key, 'Atomic preparation');
    const original = { text: 'Task' };
    const id = store.promptQueue.enqueue(session.id, 1, 42, 42, original, { skills: ['review'] });
    store.db.exec(`CREATE TRIGGER fail_preparation BEFORE UPDATE ON prompt_queue_preparations
      BEGIN SELECT RAISE(ABORT, 'preparation checkpoint unavailable'); END`);
    assert.throws(() => store.promptQueue.replacePreparedContent(id,
      { text: '/skill:review\n\nTask' }, { skills: [] }), /preparation checkpoint unavailable/);
    assert.deepEqual(store.promptQueue.first(session.id)?.content, original);
    assert.deepEqual(store.promptQueue.first(session.id)?.preparation, { skills: ['review'] });
    store.db.exec('DROP TRIGGER fail_preparation');
    store.promptQueue.replacePreparedContent(id, { text: '/skill:review\n\nTask' }, { skills: [] });
    assert.deepEqual(store.promptQueue.first(session.id)?.content, { text: '/skill:review\n\nTask' });
    assert.deepEqual(store.promptQueue.first(session.id)?.preparation, { skills: [] });
  } finally {
    store.close();
  }
});
