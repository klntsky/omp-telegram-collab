import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { emptyConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { botId, chatId } from './telegram-data.js';

const topic = { botId, chatId, threadId: 17, instancePath: '/work/project-a' };

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
      const restored = second.getTopic(topic);
      assert.equal(restored?.id, original.id);
      assert.equal(restored?.status, 'closed');
      assert.equal(restored?.name, 'Authentication complete');
      assert.deepEqual(restored?.runtime, { kind: 'attached', instanceId: 'instance-a', sessionId: 'omp-session-a' });
      assert.equal(restored?.instancePath, topic.instancePath);
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

test('one bot and topic tuple cannot acquire two session identities', () => {
  const store = new Store(':memory:');
  try {
    const original = store.createSession(topic, 'Original');
    try {
      store.createSession(topic, 'Duplicate service update');
    } catch {
      assert.equal(store.getTopic(topic)?.id, original.id);
    }
    assert.equal(store.getTopic(topic)?.id, original.id);
    assert.equal(store.listSessions(botId).length, 1);
    const otherBot = store.createSession({ ...topic, botId: botId + 1 }, 'Other bot');
    const otherChat = store.createSession({ ...topic, chatId: chatId - 1 }, 'Other group');
    assert.notEqual(otherBot.id, original.id);
    assert.notEqual(otherChat.id, original.id);
    assert.equal(store.isEnrolled(botId + 1, chatId), false);
  } finally {
    store.close();
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

test('confirmed topic icons persist exactly across restart and clearing stays isolated and durable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-topic-icons-'));
  const filename = join(directory, 'topics.sqlite');
  let store = new Store(filename);
  try {
    const target = store.createSession(topic, 'Target');
    const others = [
      store.createSession({ ...topic, threadId: topic.threadId + 1 }, 'Other topic'),
      store.createSession({ ...topic, botId: botId + 1 }, 'Other bot'),
      store.createSession({ ...topic, chatId: chatId - 1 }, 'Other chat'),
    ];
    const iconId = '5368324170671202286';
    const otherIconId = '5372981976804366741';
    assert.equal(store.getTopicIcon(target.id), undefined);
    assert.equal(store.getTopicIcon('unknown-session'), undefined);
    store.setTopicIcon(target.id, otherIconId);
    store.setTopicIcon(target.id, iconId);
    for (const other of others) {
      assert.equal(store.getTopicIcon(other.id), undefined);
      store.setTopicIcon(other.id, otherIconId);
    }
    store.close();
    store = new Store(filename);
    assert.equal(store.getTopicIcon(target.id), iconId);
    for (const other of others) assert.equal(store.getTopicIcon(other.id), otherIconId);
    store.setTopicIcon(target.id, undefined);
    assert.equal(store.getTopicIcon(target.id), undefined);
    store.close();
    store = new Store(filename);
    assert.equal(store.getTopicIcon(target.id), undefined);
    assert.equal(store.getTopic(topic)?.id, target.id);
    for (const other of others) assert.equal(store.getTopicIcon(other.id), otherIconId);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy backfill preserves session identity, history, initial state and generations transactionally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-legacy-path-'));
  const filename = join(directory, 'telegram.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,initial_task TEXT,initial_state TEXT,UNIQUE(bot_id,chat_id,thread_id));`);
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('preserved-id', botId, chatId, 17, 'Legacy task', 'closed', JSON.stringify({ kind: 'attached', instanceId: 'old-host', sessionId: 'old-history' }), 123, 'Pending task', 'pending');
  legacy.close();
  const store = new Store(filename);
  try {
    store.markSnapshot('preserved-id');
    store.rememberReply('preserved-id', 'old-reply');
    store.advanceSessionGeneration('preserved-id');
    store.setReplyTarget('preserved-id', 77);
    assert.equal(store.getTopicIcon('preserved-id'), undefined);
    store.setTopicIcon('preserved-id', '5368324170671202286');
    const before = store.getSession('preserved-id')!;
    assert.equal(before.instancePath, '');
    const config = emptyConfig(join(directory, 'config.yaml'));
    config.instances = { [topic.instancePath]: { admins: ['ada'], chats: [{ botId, chatId }] } };
    store.assignSessionPaths(config);
    store.assignSessionPaths(config);
    assert.deepEqual(store.getSession('preserved-id'), { ...before, instancePath: topic.instancePath });
    assert.equal(store.getSessionGeneration('preserved-id'), 1);
    assert.equal(store.hasPendingInitialTask('preserved-id'), true);
    assert.equal(store.hasSnapshot('preserved-id'), true);
    assert.equal(store.rememberReply('preserved-id', 'old-reply'), false);
    assert.equal(store.getReplyTarget('preserved-id'), 77);
    assert.equal(store.getTopicIcon('preserved-id'), '5368324170671202286');
    config.instances = {};
    assert.doesNotThrow(() => store.assignSessionPaths(config), 'removing assignments must preserve disconnected histories');
    config.instances = { '/work/other': { admins: ['grace'], chats: [{ botId, chatId }] } };
    assert.throws(() => store.assignSessionPaths(config), /history pinned/);
    assert.equal(store.getSession('preserved-id')?.instancePath, topic.instancePath);
    assert.throws(() => store.createSession({ ...topic, instancePath: '/work/other' }, 'Retarget'), /history belongs/);
    assert.equal(store.claimInitialTask('preserved-id'), 'Pending task');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('one path can bind several bots and chats without merging topic identities', () => {
  const store = new Store(':memory:');
  try {
    const config = emptyConfig('/work/config.yaml');
    config.instances = {
      '/work/a': { admins: ['ada'], chats: [{ botId, chatId }, { botId: botId + 1, chatId }, { botId, chatId: chatId - 1 }] },
      '/work/b': { admins: ['grace'], chats: [{ botId: botId + 1, chatId: chatId - 1 }] },
    };
    const sessions = Object.entries(config.instances).flatMap(([instancePath, instance]) => instance.chats.map(chat => store.createSession({ ...chat, threadId: 17, instancePath }, instancePath)));
    store.assignSessionPaths(config);
    assert.equal(new Set(sessions.map(session => session.id)).size, 4);
    assert.equal(sessions.filter(session => session.instancePath === '/work/a').length, 3);
    store.db.prepare('UPDATE sessions SET instance_path=NULL WHERE id=?').run(sessions[0]!.id);
    config.instances['/work/b']!.chats.push({ botId: botId + 2, chatId });
    const unknown = store.createSession({ botId: botId + 2, chatId, threadId: 18, instancePath: '/work/unrecognized' }, 'Unknown history');
    assert.throws(() => store.assignSessionPaths(config), /history pinned/);
    assert.equal(store.getSession(sessions[0]!.id)?.instancePath, '', 'a later mismatch rolls back earlier NULL backfills');
    assert.equal(store.getSession(unknown.id)?.instancePath, '/work/unrecognized');
  } finally {
    store.close();
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
