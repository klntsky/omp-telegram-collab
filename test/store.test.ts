import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { topicDestination } from '../shared/topic-destination.js';
import { OmpRuntime } from '../src/runtime.js';
import { botId, chatId } from './telegram-data.js';
import { initializeDatabase } from '../src/migrations.js';

const topic = { botId, chatId, threadId: 17, instanceId: 1, cwd: '/work/project-a' };

test('status identities include legacy stored rows and remain detached after replacement', () => {
  const store = new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO bot_status_topics VALUES (?,?,?)').run(botId,chatId,topic.threadId);
    assert.equal(store.getTopicKind(topic), 'detached');
    assert.throws(() => store.createSession(topic, 'Legacy status'));
    store.setBotStatusTopic(botId, chatId, 18);
    assert.equal(store.getBotStatusTopic(botId, chatId), 18);
    assert.equal(store.getTopicKind(topic), 'detached');
    assert.equal(store.getTopicKind({...topic,threadId:18}), 'detached');
    assert.throws(() => store.createSession({...topic,threadId:18}, 'Current status'));
    assert.deepEqual(store.listSessions(botId), []);
  } finally { store.close(); }
});
// Permanent persistence boundary: existing cwd tests do not cover configured policy identity surviving relocation and fork inheritance.
test('worktree policy identity survives relocation and is inherited by forks', () => {
  const store = new Store(':memory:');
  try {
    const source = store.createSession(topic, 'Source');
    store.setSessionCwd(source.id, '/work/worktree');
    const relocated = store.getSession(source.id)!;
    assert.equal(relocated.worktreePolicyCwd, topic.cwd);
    const fork = store.createSession({ ...topic, threadId: 18, cwd: relocated.cwd, worktreePolicyCwd: relocated.worktreePolicyCwd }, 'Fork');
    store.setSessionCwd(fork.id, '/work/fork-worktree');
    assert.equal(store.getSession(fork.id)?.worktreePolicyCwd, topic.cwd);
    assert.equal(store.getSession(fork.id)?.cwd, '/work/fork-worktree');
  } finally { store.close(); }
});

// Permanent migration boundary: existing schema rejection tests do not cover preserving legacy sessions through the policy upgrade.
test('version 12 upgrade preserves sessions and initializes policy identity conservatively', () => {
  const store = new Store(':memory:');
  try {
    const source = store.createSession(topic, 'Legacy');
    store.setSessionCwd(source.id, '/work/legacy-worktree');
    store.db.exec('ALTER TABLE sessions DROP COLUMN worktree_policy_cwd; PRAGMA user_version=12');
    initializeDatabase(store.db);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 13);
    const restored = store.getSession(source.id)!;
    assert.equal(restored.worktreePolicyCwd, '/work/legacy-worktree');
    assert.equal(restored.name, 'Legacy');
    assert.equal(restored.instanceId, topic.instanceId);
    initializeDatabase(store.db);
    assert.deepEqual(store.getSession(source.id), restored);
  } finally { store.close(); }
});

test('detached identities and retired status history survive reopening storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-detached-topics-'));
  const filename = join(directory, 'topics.sqlite');
  let store = new Store(filename);
  try {
    const session = store.createSession(topic, 'Former session');
    store.setBotStatusTopic(botId,chatId,topic.threadId);
    store.setBotStatusTopic(botId,chatId,18);
    store.detachTopic({...topic,threadId:19});
    store.close();
    store = new Store(filename);
    for (const threadId of [topic.threadId,18,19]) {
      assert.equal(store.getTopicKind({...topic,threadId}), 'detached');
      assert.throws(() => store.createSession({...topic,threadId}, 'Cannot recreate'));
    }
    assert.equal(store.getSession(session.id)?.status, 'detached');
    assert.equal(store.getSession(session.id)?.name, 'Former session');
    assert.equal(store.getBotStatusTopic(botId,chatId),18);
  } finally {
    store.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('existing detached sessions classify as detached without a topic identity row', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(topic, 'Detached history');
    store.updateSession(session.id, {status:'detached'});
    assert.equal(store.getTopicKind(topic), 'detached');
    assert.throws(() => store.createSession(topic, 'Cannot revive'));
    assert.equal(store.getSession(session.id)?.name, 'Detached history');
  } finally { store.close(); }
});

test('topic display and generated prefix commit together or both roll back', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(topic, 'Initial title');
    store.setTopicTitle(session.id, 'old-branch Readable title', 'old-branch');
    store.db
      .exec(`CREATE TEMP TRIGGER reject_topic_prefix BEFORE UPDATE ON session_topic_title_prefixes
      BEGIN SELECT RAISE(ABORT,'Fixture prefix write failed'); END`);
    assert.throws(
      () => store.setTopicTitle(session.id, 'new-branch Readable title', 'new-branch'),
      (error) => error instanceof Error && error.message === 'Fixture prefix write failed',
    );
    assert.equal(store.getSession(session.id)?.name, 'old-branch Readable title');
    assert.equal(store.getTopicTitlePrefix(session.id), 'old-branch');
    store.db.exec('DROP TRIGGER reject_topic_prefix');
    store.setTopicTitle(session.id, 'new-branch Readable title', 'new-branch');
    assert.equal(store.getSession(session.id)?.name, 'new-branch Readable title');
    assert.equal(store.getTopicTitlePrefix(session.id), 'new-branch');
  } finally {
    store.close();
  }
});

test('topic identity survives a service restart and closing preserves its history binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-telegram-store-'));
  const filename = join(dir, 'topics.sqlite');
  try {
    const first = new Store(filename);
    first.enrollGroup(botId, chatId);
    const original = first.createSession(topic, 'Implement auth', { kind: 'attached', instanceId: 'instance-a', sessionId: 'omp-session-a' });
    first.setReplyTarget(original.id, 1234);
    first.updateSession(original.id, { status: 'closed', name: 'Authentication complete' });
    first.close();
    const second = new Store(filename);
    try {
      assert.equal(second.isEnrolled(botId, chatId), true);
      const restored = second.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, topic.threadId)});
      assert.equal(restored?.id, original.id);
      assert.equal(restored?.status, 'closed');
      assert.equal(restored?.name, 'Authentication complete');
      assert.deepEqual(restored?.runtime, { kind: 'attached', instanceId: 'instance-a', sessionId: 'omp-session-a' });
      assert.equal(restored?.cwd, topic.cwd);
      assert.equal(second.getReplyTarget(original.id), 1234);
      second.setReplyTarget(original.id, undefined);
      assert.equal(second.getReplyTarget(original.id), undefined);
      second.updateSession(original.id, { status: 'open' });
      assert.equal(second.getSession(original.id)?.status, 'open');
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('initial task message provenance survives restart without acknowledging it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-initial-message-'));
  const filename = join(directory, 'topics.sqlite');
  let store = new Store(filename);
  try {
    const task = { text: 'Initial task awaiting admission' };
    const session = store.createSession(topic, 'Pending task', { kind: 'managed' }, { prompt: { messageId: 7101, userId: 42, authorityUserId: 42, content: task } });
    store.close();
    store = new Store(filename);
    assert.equal(store.promptQueue.first(session.id)?.messageId, 7101);
    assert.equal(store.getReplyTarget(session.id), undefined);
    assert.deepEqual(store.promptQueue.first(session.id)?.content, task);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('image-only initial content survives reopening storage and stays session-scoped', async () => {
  const directory = await mkdtemp(join(tmpdir(),'omp-image-task-'));
  const filename = join(directory,'topics.sqlite');
  const images = [{type:'image' as const,data:'aW1hZ2U=',mimeType:'image/png'}];
  try {
    const first = new Store(filename);
    let id: string;
    try {
      id = first.createSession(topic,'Image task',{kind:'managed'},{prompt:{messageId:1,userId:42,authorityUserId:42,content:{text:'',images}}}).id;
      first.createSession({...topic,threadId:18},'Unrelated',{kind:'managed'},{prompt:{messageId:2,userId:43,authorityUserId:44,content:{text:'Other task'}}});
    } finally {
      first.close();
    }
    const restored = new Store(filename);
    try {
      const queued = restored.promptQueue.first(id)!;
      assert.equal(queued.userId,42);
      assert.equal(queued.authorityUserId,42);
      assert.deepEqual(queued.content,{text:'',images});
      restored.promptQueue.remove(queued.id);
      assert.equal(restored.promptQueue.has(id),false);
      const unrelated = restored.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, 18)})!;
      assert.equal(restored.promptQueue.first(unrelated.id)?.userId,43);
      assert.equal(restored.promptQueue.first(unrelated.id)?.authorityUserId,44);
      assert.deepEqual(restored.promptQueue.first(unrelated.id)?.content,{text:'Other task'});
    } finally {
      restored.close();
    }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

test('kill generations persist across restart and stay isolated to their session', async () => {
  const directory = await mkdtemp(join(tmpdir(),'omp-session-generation-'));
  const filename = join(directory,'topics.sqlite');
  let store = new Store(filename);
  try {
    const target = store.createSession(topic,'Target');
    const other = store.createSession({...topic,threadId:18},'Other');
    assert.equal(store.getSessionGeneration(target.id),0);
    store.advanceSessionGeneration(target.id);
    store.advanceSessionGeneration(target.id);
    store.close();
    store = new Store(filename);
    assert.equal(store.getSessionGeneration(target.id),2);
    assert.equal(store.getSessionGeneration(other.id),0);
    store.advanceSessionGeneration(target.id);
    assert.equal(store.getSessionGeneration(target.id),3);
  } finally {
    store.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('current sessions retain pending tasks and delivery metadata across a disk reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-current-path-'));
  const filename = join(directory, 'telegram.sqlite');
  let store = new Store(filename);
  try {
    const original = store.createSession(topic, 'Pending task', { kind: 'managed' }, {prompt:{messageId:1,userId:123,authorityUserId:456,content:{text:'Pending instruction'}}});
    store.markSnapshot(original.id);
    store.replies.stage(original.id, 'omp-session', 'saved-reply', null, ['first', 'second'], 77, 0);
    const reply = store.replies.pending(original.id)[0]!;
    store.replies.confirm(reply, chatId, 78);
    store.advanceSessionGeneration(original.id);
    store.setReplyTarget(original.id, 77);
    store.close();
    store = new Store(filename);
    assert.deepEqual(store.getSession(original.id), original);
    assert.equal(store.getSessionGeneration(original.id), 1);
    assert.equal(store.promptQueue.has(original.id), true);
    assert.equal(store.promptQueue.first(original.id)?.userId, 123);
    assert.equal(store.promptQueue.first(original.id)?.authorityUserId, 456);
    assert.equal(store.hasSnapshot(original.id), true);
    assert.deepEqual(store.replies.pending(original.id), [{...reply,nextPart:1}]);
    assert.deepEqual(store.getMessageAnchor(original.id, 'omp-session', chatId, 78),
      {ompSessionId:'omp-session',entryId:'saved-reply',parentEntryId:null,kind:'assistant',partIndex:0});
    assert.equal(store.getReplyTarget(original.id), 77);
    assert.throws(() => store.createSession({ ...topic, instanceId: 2, cwd: '/work/other' }, 'Retarget'), /history belongs/);
    assert.deepEqual(store.getSession(original.id), original);
    assert.deepEqual(store.promptQueue.first(original.id)?.content, {text:'Pending instruction'});
    store.promptQueue.remove(store.promptQueue.first(original.id)!.id);
    assert.equal(store.promptQueue.first(original.id), undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('logical assignments survive default-directory changes and missing session directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-validate-identity-'));
  const originalPath = join(directory, 'missing-original');
  const otherPath = join(directory, 'other');
  const config = emptyConfig(join(directory, 'config.yaml'));
  config.dataDir = directory;
  config.instances = [{ id: 1, defaultDir: otherPath, chats: [{ botId, chatId }] }];
  const store = new Store(join(directory, 'store.sqlite'));
  const runtime = new OmpRuntime(config);
  try {
    for (const status of ['open', 'closed', 'detached'] as const) {
      const session = store.createSession({ ...topic, threadId: 20 + ['open', 'closed', 'detached'].indexOf(status), cwd: originalPath }, status);
      store.updateSession(session.id, { status });
    }
    const sessions = store.listSessions();
    await runtime.validateSessionPaths(sessions);
    await runtime.validateSessionPaths(sessions, { ...config, instances: [] });
    const reassigned = { ...config, instances: [{ id: 2, defaultDir: otherPath, chats: [{ botId, chatId }] }] };
    for (const session of sessions) {
      await assert.rejects(runtime.validateSessionPaths([session], reassigned), /history pinned to another instance ID/);
      assert.equal(store.getSession(session.id)?.cwd, originalPath);
    }
    const original = sessions[0]!;
    const existing = store.createSession({ ...topic, threadId: original.threadId, cwd: otherPath }, 'Existing');
    assert.equal(existing.cwd, originalPath);
    assert.throws(() => store.createSession({ ...topic, threadId: original.threadId, instanceId: 2, cwd: originalPath }, 'Other identity'), /different instance ID/);
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('session cwd and logical identity persist independently across database restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-session-cwd-'));
  const filename = join(directory, 'store.sqlite');
  let store = new Store(filename);
  try {
    const original = store.createSession(topic, 'Original');
    store.setSessionCwd(original.id, '/work/selected-worktree');
    store.setSkillCatalog(1, [{ name: 'first', description: '' }]);
    store.setSkillCatalog(2, [{ name: 'second', description: '' }]);
    store.close();
    store = new Store(filename);
    assert.equal(store.getSession(original.id)?.instanceId, 1);
    assert.equal(store.getSession(original.id)?.cwd, '/work/selected-worktree');
    assert.deepEqual(store.getSession(original.id)?.runtime, { kind: 'managed' });
    assert.deepEqual(store.getSkillCatalog(1), [{ name: 'first', description: '' }]);
    assert.deepEqual(store.getSkillCatalog(2), [{ name: 'second', description: '' }]);
    const second = store.createSession({ ...topic, threadId: 99, instanceId: 2 }, 'Same cwd, other identity');
    assert.equal(second.cwd, original.cwd);
    assert.equal(second.instanceId, 2);
    for (const instanceId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.createSession({ ...topic, threadId: 100, instanceId }, 'Invalid'), /positive safe integer/);
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported database schemas are rejected without attempting an upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-schema-cutover-'));
  const filename = join(directory, 'store.sqlite');
  try {
    const store = new Store(filename);
    store.db.exec('PRAGMA user_version=3');
    store.close();
    assert.throws(() => new Store(filename), /Unsupported database schema version 3/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup requests rotate safely, remain isolated by bot and expire after ten minutes', t => {
  const store = new Store(':memory:');
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  try {
    const input = { botId, chatId, userId: 123, username: 'ada', title: 'Project $(untrusted)' };
    const first = store.createSetupRequest(input);
    assert.deepEqual(store.getSetupRequest(first.code), first);
    assert.equal(first.expiresAt, now + 600000);
    const rotated = store.createSetupRequest({ ...input, title: 'Renamed project' });
    assert.notEqual(rotated.code, first.code);
    assert.equal(store.getSetupRequest(first.code), undefined);
    const otherBot = store.createSetupRequest({ ...input, botId: botId + 1 });
    assert.equal(store.listSetupRequests().length, 2);
    store.consumeSetupRequest(rotated.code);
    assert.equal(store.getSetupRequest(rotated.code), undefined);
    assert.ok(store.getSetupRequest(otherBot.code));
    now = otherBot.expiresAt;
    assert.equal(store.getSetupRequest(otherBot.code), undefined);
    assert.deepEqual(store.listSetupRequests(), []);
    const renewed = store.createSetupRequest({ ...input, username: undefined });
    assert.equal(store.getSetupRequest(renewed.code)?.username, undefined);
    assert.equal(store.listSetupRequests().length, 1);
  } finally {
    store.close();
  }
});
