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

for (const conversion of ['detach', 'status'] as const) {
test(`${conversion} conversion retires its session and title work without deleting history`, () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(topic, 'Preserved history', {kind:'managed'}, {text:'Never submit'});
    const other = store.createSession({...topic,threadId:18}, 'Other topic');
    store.setReplyTarget(session.id, 1234);
    store.setPendingSessionTitle(session.id, 'Pending rename');
    store.setTopicTitlePrefix(session.id, 'feature/pending');
    const generation = store.getSessionGeneration(session.id);
    if (conversion === 'status') store.setBotStatusTopic(botId,chatId,topic.threadId);
    else store.detachTopic(topic);
    assert.equal(store.getTopicKind(topic), 'detached');
    assert.equal(store.getSession(session.id)?.status, 'detached');
    assert.equal(store.getSession(session.id)?.name, 'Preserved history');
    assert.equal(store.getReplyTarget(session.id), 1234);
    assert.equal(store.getTopic({botId,destination:topicDestination(chatId,topic.threadId)})?.id, session.id);
    assert.equal(store.getPendingSessionTitle(session.id), undefined);
    assert.equal(store.getTopicTitlePrefix(session.id), undefined);
    assert.equal(store.getSessionGeneration(session.id), generation + 1);
    assert.equal(store.hasPendingInitialTask(session.id), false);
    assert.equal(store.claimInitialTask(session.id), undefined);
    store.detachTopic(topic);
    assert.equal(store.getSessionGeneration(session.id), generation + 1);
    assert.equal(store.getSession(other.id)?.status, 'open');
    assert.equal(store.getPendingSessionTitle(other.id), 'Other topic');
    assert.throws(() => store.createSession(topic, 'Cannot revive'));
  } finally { store.close(); }
});
}

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

test('initial task message provenance survives restart without acknowledging it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-initial-message-'));
  const filename = join(directory, 'topics.sqlite');
  let store = new Store(filename);
  try {
    const task = { text: 'Initial task awaiting admission' };
    const session = store.createSession(topic, 'Pending task', { kind: 'managed' }, task, 42);
    store.setInitialMessage(session.id, 7101);
    store.close();
    store = new Store(filename);
    assert.equal(store.getInitialMessage(session.id), 7101);
    assert.equal(store.getReplyTarget(session.id), undefined);
    assert.deepEqual(store.claimInitialTask(session.id), task);
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
      id = first.createSession(topic,'Image task',{kind:'managed'},{text:'',images},42).id;
      first.createSession({...topic,threadId:18},'Unrelated',{kind:'managed'},{text:'Other task'},43,44);
    } finally {
      first.close();
    }
    const restored = new Store(filename);
    try {
      assert.equal(restored.hasPendingInitialTask(id),true);
      assert.equal(restored.getInitialUser(id),42);
      assert.equal(restored.getInitialAuthority(id),42);
      const unrelated = restored.getTopic({botId: topic.botId, destination: topicDestination(topic.chatId, 18)})!;
      assert.deepEqual(restored.claimInitialTask(id),{text:'',images});
      assert.equal(restored.hasPendingInitialTask(id),false);
      assert.equal(restored.db.prepare('SELECT initial_state FROM sessions WHERE id=?').get(id)?.initial_state,'submitted');
      assert.equal(restored.claimInitialTask(id),undefined);
      assert.equal(restored.hasPendingInitialTask(unrelated.id),true);
      assert.equal(restored.getInitialUser(unrelated.id),43);
      assert.equal(restored.getInitialAuthority(unrelated.id),44);
      assert.deepEqual(restored.claimInitialTask(unrelated.id),{text:'Other task'});
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
    const original = store.createSession(topic, 'Pending task', { kind: 'managed' }, {text:'Pending instruction'}, 123, 456);
    store.markSnapshot(original.id);
    store.rememberReply(original.id, 'omp-session', 'saved-reply');
    store.advanceSessionGeneration(original.id);
    store.setReplyTarget(original.id, 77);
    store.close();
    store = new Store(filename);
    assert.deepEqual(store.getSession(original.id), original);
    assert.equal(store.getSessionGeneration(original.id), 1);
    assert.equal(store.hasPendingInitialTask(original.id), true);
    assert.equal(store.getInitialUser(original.id), 123);
    assert.equal(store.getInitialAuthority(original.id), 456);
    assert.equal(store.hasSnapshot(original.id), true);
    assert.equal(store.rememberReply(original.id, 'omp-session', 'saved-reply'), false);
    assert.equal(store.getReplyTarget(original.id), 77);
    assert.throws(() => store.createSession({ ...topic, instancePath: '/work/other' }, 'Retarget'), /history belongs/);
    assert.deepEqual(store.getSession(original.id), original);
    assert.deepEqual(store.claimInitialTask(original.id), {text:'Pending instruction'});
    assert.equal(store.claimInitialTask(original.id), undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
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
  config.instances = { [originalPath]: { chats: [{ botId, chatId }] } };
  const store = new Store(':memory:');
  const runtime = new OmpRuntime(config);
  try {
    const managed = store.createSession({ ...topic, instancePath: originalPath }, 'Managed');
    const attached = store.createSession({ ...topic, threadId: 18, instancePath: originalPath }, 'Attached', { kind: 'attached', instanceId: 'host', sessionId: 'history' });
    await runtime.validateSessionPaths(store.listSessions());
    const retargeted = { ...config, instances: { [otherPath]: { chats: [{ botId, chatId }] } } };
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
