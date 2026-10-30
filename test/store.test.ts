import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { topicDestination } from '../shared/topic-destination.js';
import { OmpRuntime } from '../src/runtime.js';
import { botId, chatId } from './telegram-data.js';

const topic = { botId, chatId, threadId: 17, instancePath: '/work/project-a' };

test('General never becomes a session or changes topic history and pending selections', () => {
  const store = new Store(':memory:');
  const general = topicDestination(chatId);
  const destination = topicDestination(chatId, topic.threadId);
  try {
    const created = store.createSession(topic, 'Actual topic');
    store.addPendingSkill({botId,destination:general,userId:42}, 'general-skill');
    store.addPendingSkill({botId,destination,userId:42}, 'topic-skill');
    assert.equal(store.getTopic({botId,destination:general}), undefined);
    assert.equal(store.getTopic({botId,destination})?.id, created.id);
    assert.throws(() => store.createSession({...topic,threadId:1}, 'General'), /A session requires a non-General topic/);
    assert.deepEqual(store.listSessions(botId).map(session => session.id), [created.id]);
    store.clearPendingSkills({botId,destination:general,userId:42});
    assert.deepEqual(store.getPendingSkills({botId,destination,userId:42}), ['topic-skill']);
    assert.equal(store.getTopic({botId,destination})?.id, created.id);
  } finally {
    store.close();
  }
});

test('task requests match destination, bot, and user before being consumed', () => {
  const store = new Store(':memory:');
  const general = topicDestination(chatId);
  const destination = topicDestination(chatId, topic.threadId);
  try {
    store.addTaskRequest(botId, general, 10, 42);
    assert.equal(store.db.prepare('SELECT thread_id FROM task_requests WHERE message_id=10').get()?.thread_id, 1);
    assert.equal(store.takeTaskRequest(botId, destination, 10, 42), false);
    assert.equal(store.takeTaskRequest(botId + 1, general, 10, 42), false);
    assert.equal(store.takeTaskRequest(botId, general, 10, 43), false);
    assert.equal(store.takeTaskRequest(botId, general, 10, 42), true);
    assert.equal(store.takeTaskRequest(botId, general, 10, 42), false);
    store.addTaskRequest(botId, destination, 11, 42);
    assert.equal(store.takeTaskRequest(botId, general, 11, 42), false);
    assert.equal(store.takeTaskRequest(botId, destination, 11, 42), true);
  } finally {
    store.close();
  }
});

test('disk and in-memory stores reject missing instance paths and orphan reply targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-current-schema-'));
  const disk = new Store(join(directory, 'topics.sqlite'));
  const memory = new Store(':memory:');
  try {
    for (const store of [disk, memory]) {
      assert.throws(() => store.setReplyTarget('unknown-session', 7), /FOREIGN KEY constraint failed/);
      assert.throws(() => store.createSession({ ...topic, instancePath: '' }, 'Missing path'));
      const created = store.createSession(topic, 'Current schema');
      assert.equal(created.instancePath, topic.instancePath);
      assert.throws(() => store.db.prepare('UPDATE sessions SET instance_path=NULL WHERE id=?').run(created.id), /NOT NULL constraint failed/);
      assert.equal(store.getSession(created.id)?.instancePath, topic.instancePath);
    }
  } finally {
    disk.close();
    memory.close();
    await rm(directory, { recursive: true, force: true });
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

test('initial images survive reopening storage with their pending task and stay session-scoped', async () => {
  const directory = await mkdtemp(join(tmpdir(),'omp-image-task-'));
  const filename = join(directory,'topics.sqlite');
  const images = [{type:'image' as const,data:'aW1hZ2U=',mimeType:'image/png'}];
  try {
    const first = new Store(filename);
    let id: string;
    try {
      id = first.createSession(topic,'Image task',{kind:'managed'},'Inspect this',42,images).id;
      first.createSession({...topic,threadId:18},'Unrelated',{kind:'managed'},'Other task',42);
    } finally {
      first.close();
    }
    const restored = new Store(filename);
    try {
      assert.equal(restored.hasPendingInitialTask(id),true);
      assert.deepEqual(restored.getInitialImages(id),images);
      const unrelated = restored.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, 18)})!;
      assert.equal(restored.getInitialImages(unrelated.id),undefined);
      assert.equal(restored.claimInitialTask(id),'Inspect this');
      assert.equal(restored.claimInitialTask(id),undefined);
    } finally {
      restored.close();
    }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

test('one bot and topic tuple cannot acquire two session identities', () => {
  const store = new Store(':memory:');
  try {
    const original = store.createSession(topic, 'Original');
    try {
      store.createSession(topic, 'Duplicate service update');
    } catch {
      assert.equal(store.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, topic.threadId)})?.id, original.id);
    }
    assert.equal(store.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, topic.threadId)})?.id, original.id);
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
    assert.equal(store.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, topic.threadId)})?.id, target.id);
    for (const other of others) assert.equal(store.getTopicIcon(other.id), otherIconId);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('current sessions retain pending tasks and delivery metadata across a disk reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-current-path-'));
  const filename = join(directory, 'telegram.sqlite');
  let store = new Store(filename);
  try {
    const original = store.createSession(topic, 'Pending task', { kind: 'managed' }, 'Pending instruction', 123);
    store.markSnapshot(original.id);
    store.rememberReply(original.id, 'saved-reply');
    store.advanceSessionGeneration(original.id);
    store.setReplyTarget(original.id, 77);
    store.setTopicIcon(original.id, '5368324170671202286');
    store.close();
    store = new Store(filename);
    assert.deepEqual(store.getSession(original.id), original);
    assert.equal(store.getSessionGeneration(original.id), 1);
    assert.equal(store.hasPendingInitialTask(original.id), true);
    assert.equal(store.getInitialUser(original.id), 123);
    assert.equal(store.hasSnapshot(original.id), true);
    assert.equal(store.rememberReply(original.id, 'saved-reply'), false);
    assert.equal(store.getReplyTarget(original.id), 77);
    assert.equal(store.getTopicIcon(original.id), '5368324170671202286');
    assert.throws(() => store.createSession({ ...topic, instancePath: '/work/other' }, 'Retarget'), /history belongs/);
    assert.deepEqual(store.getSession(original.id), original);
    assert.equal(store.claimInitialTask(original.id), 'Pending instruction');
    assert.equal(store.claimInitialTask(original.id), undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('one path can bind several bots and chats without merging topic identities', () => {
  const store = new Store(':memory:');
  try {
    const instances = {
      '/work/a': { chats: [{ botId, chatId }, { botId: botId + 1, chatId }, { botId, chatId: chatId - 1 }] },
      '/work/b': { chats: [{ botId: botId + 1, chatId: chatId - 1 }] },
    };
    const sessions = Object.entries(instances).flatMap(([instancePath, instance]) => instance.chats.map(chat => store.createSession({ ...chat, threadId: 17, instancePath }, instancePath)));
    assert.equal(new Set(sessions.map(session => session.id)).size, 4);
    assert.equal(sessions.filter(session => session.instancePath === '/work/a').length, 3);
    for (const original of sessions) {
      assert.equal(store.getTopic({botId: original.botId, destination: topicDestination(original.chatId, original.threadId)})?.id, original.id);
      const otherPath = original.instancePath === '/work/a' ? '/work/b' : '/work/a';
      assert.throws(() => store.createSession({ ...original, instancePath: otherPath }, 'Retarget'), /history belongs/);
      assert.deepEqual(store.getSession(original.id), original);
    }
  } finally {
    store.close();
  }
});

test('current path validation rejects retargeted assignments and mismatched history identities without rewriting files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-validate-path-'));
  const originalPath = join(directory, 'original');
  const otherPath = join(directory, 'other');
  await mkdir(originalPath);
  await mkdir(otherPath);
  const config = emptyConfig(join(directory, 'config.yaml'));
  config.dataDir = directory;
  config.instances = { [originalPath]: { admins: ['ada'], chats: [{ botId, chatId }] } };
  const store = new Store(':memory:');
  const runtime = new OmpRuntime(config);
  try {
    const managed = store.createSession({ ...topic, instancePath: originalPath }, 'Managed');
    const attached = store.createSession({ ...topic, threadId: 18, instancePath: originalPath }, 'Attached', { kind: 'attached', instanceId: 'host', sessionId: 'history' });
    await runtime.validateSessionPaths(store.listSessions());
    const retargeted = { ...config, instances: { [otherPath]: { admins: ['ada'], chats: [{ botId, chatId }] } } };
    for (const session of [managed, attached]) {
      await assert.rejects(runtime.validateSessionPaths([session], retargeted), /history pinned to another instance path/);
    }
    await runtime.validateSessionPaths(store.listSessions(), { ...config, instances: {} });
    const sessionDirectory = join(directory, 'sessions', managed.id);
    await mkdir(sessionDirectory, { recursive: true });
    const history = join(sessionDirectory, 'history.jsonl');
    const binding = join(sessionDirectory, 'binding.json');
    const pin = { version: 1, sessionId: 'saved-history', sessionFile: history, cwd: originalPath };
    const header = { type: 'session', version: 3, id: pin.sessionId, cwd: originalPath };
    const historyBytes = `${JSON.stringify(header)}\n`;
    await writeFile(history, historyBytes);
    await writeFile(binding, JSON.stringify(pin));
    await runtime.validateSessionPaths(store.listSessions());
    assert.equal(await readFile(history, 'utf8'), historyBytes);
    await writeFile(binding, JSON.stringify({ ...pin, cwd: otherPath }));
    await assert.rejects(runtime.validateSessionPaths([managed]));
    await writeFile(binding, JSON.stringify(pin));
    for (const changed of [{ ...header, id: 'different-history' }, { ...header, cwd: otherPath }]) {
      const changedBytes = `${JSON.stringify(changed)}\n`;
      await writeFile(history, changedBytes);
      await assert.rejects(runtime.validateSessionPaths([managed]));
      assert.equal(await readFile(history, 'utf8'), changedBytes);
      assert.equal(await readFile(binding, 'utf8'), JSON.stringify(pin));
    }
    await rm(history);
    await assert.rejects(runtime.validateSessionPaths([managed]), { code: 'ENOENT' });
    await rm(originalPath, { recursive: true });
    await symlink(otherPath, originalPath);
    await assert.rejects(runtime.validateSessionPaths([attached]), /Instance path identity changed/);
    assert.equal(store.getSession(managed.id)?.instancePath, originalPath);
  } finally {
    await runtime.close();
    store.close();
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
