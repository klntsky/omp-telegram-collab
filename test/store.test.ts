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

test('General stays outside sessions while pending selections enforce destination identities', () => {
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

test('topic display and generated prefix commit together or both roll back', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(topic,'Initial title');
    store.setTopicTitle(session.id,'old-branch Readable title','old-branch');
    store.db.exec(`CREATE TEMP TRIGGER reject_topic_prefix BEFORE UPDATE ON session_topic_title_prefixes
      BEGIN SELECT RAISE(ABORT,'Fixture prefix write failed'); END`);
    assert.throws(() => store.setTopicTitle(session.id,'new-branch Readable title','new-branch'),
      error => error instanceof Error && error.message === 'Fixture prefix write failed');
    assert.equal(store.getSession(session.id)?.name,'old-branch Readable title');
    assert.equal(store.getTopicTitlePrefix(session.id),'old-branch');
    store.db.exec('DROP TRIGGER reject_topic_prefix');
    store.setTopicTitle(session.id,'new-branch Readable title','new-branch');
    assert.equal(store.getSession(session.id)?.name,'new-branch Readable title');
    assert.equal(store.getTopicTitlePrefix(session.id),'new-branch');
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

test('absent initial content creates no task while empty supplied content is rejected', () => {
  const store = new Store(':memory:');
  try {
    const absent = store.createSession(topic,'No task',{kind:'managed'},undefined,42);
    assert.equal(store.hasPendingInitialTask(absent.id),false);
    assert.equal(store.claimInitialTask(absent.id),undefined);
    assert.equal(store.getInitialUser(absent.id),undefined);
    assert.equal(store.getInitialAuthority(absent.id),undefined);
    assert.deepEqual(store.db.prepare('SELECT initial_task,initial_state FROM sessions WHERE id=?').get(absent.id),Object.assign(Object.create(null),{initial_task:null,initial_state:null}));
    for (const content of [{text:''},{text:' \n\t '},{text:'',images:[]}]) {
      assert.throws(() => store.createSession({...topic,threadId:18},'Invalid',{kind:'managed'},content,42),/An initial task requires text or images/);
      assert.equal(store.getTopic({botId,destination:topicDestination(chatId,18)}),undefined);
    }
    const text = {text:'  Preserve task whitespace  '};
    const pending = store.createSession({...topic,threadId:18},'Text task',{kind:'managed'},text);
    assert.equal(store.hasPendingInitialTask(pending.id),true);
    assert.equal(store.db.prepare('SELECT initial_task FROM sessions WHERE id=?').get(pending.id)?.initial_task,text.text);
    assert.deepEqual(store.claimInitialTask(pending.id),text);
    assert.equal(store.hasPendingInitialTask(pending.id),false);
    const cancelled = store.createSession({...topic,threadId:19},'Cancelled',{kind:'managed'},{text:'Do not send'});
    store.cancelInitialTask(cancelled.id);
    assert.equal(store.hasPendingInitialTask(cancelled.id),false);
    assert.equal(store.claimInitialTask(cancelled.id),undefined);
    assert.equal(store.db.prepare('SELECT initial_state FROM sessions WHERE id=?').get(cancelled.id)?.initial_state,'cancelled');
  } finally {
    store.close();
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


test('human finish icons persist across restart and preserve empty and status choices', async () => {
  const directory = await mkdtemp(join(tmpdir(),'omp-topic-finish-icons-'));
  const filename = join(directory,'topics.sqlite');
  let store = new Store(filename);
  try {
    const preferences = ['human-selected-icon','','5312016608254762256','5408906741125490282','5237699328843200968'];
    const sessions = preferences.map((preference,index) => {
      const session = store.createSession({...topic,threadId:topic.threadId+index},`Preference ${index}`);
      assert.equal(store.getTopicFinishIcon(session.id),undefined);
      store.setTopicFinishIcon(session.id,preference);
      assert.equal(store.getTopicFinishIcon(session.id),preference);
      return session;
    });
    const otherBot = store.createSession({...topic,botId:botId+1},'Other bot');
    const otherChat = store.createSession({...topic,chatId:chatId-1},'Other chat');
    store.close();
    store = new Store(filename);
    for (const [index,session] of sessions.entries()) {
      assert.equal(store.getTopicFinishIcon(session.id),preferences[index]);
    }
    assert.equal(store.getTopicFinishIcon(otherBot.id),undefined);
    assert.equal(store.getTopicFinishIcon(otherChat.id),undefined);
    assert.equal(store.getTopicFinishIcon('unknown-session'),undefined);
    store.setTopicFinishIcon(sessions[0]!.id,'updated-human-icon');
    store.close();
    store = new Store(filename);
    assert.equal(store.getTopicFinishIcon(sessions[0]!.id),'updated-human-icon');
    for (const [index,session] of sessions.entries()) {
      if (index > 0) assert.equal(store.getTopicFinishIcon(session.id),preferences[index]);
    }
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
    store.rememberReply(original.id, 'saved-reply');
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
    assert.equal(store.rememberReply(original.id, 'saved-reply'), false);
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
