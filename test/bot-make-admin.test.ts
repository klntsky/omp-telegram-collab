import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GrammyError } from 'grammy';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { readConfig, writeConfig } from '../src/config.js';
import { botId, chatId, ownerId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';
import { Store } from '../src/store.js';
import { topicDestination } from '../shared/topic-destination.js';

type SmokeApp = Awaited<ReturnType<typeof createSmokeApp>>;
const grace = { id: ownerId + 20, first_name: 'Grace', username: 'grace', is_bot: false };
const alan = { id: ownerId + 21, first_name: 'Alan', username: 'alan', is_bot: false };
const otherChat = { id: chatId - 1, type: 'supergroup', title: 'Other project', is_forum: true };

function mockMembers(t: TestContext, app: SmokeApp) {
  const original = app.bot.api.getChatMember.bind(app.bot.api);
  t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
    const member = await original(...args);
    const user = [grace, alan].find(candidate => candidate.id === args[1]);
    return user ? { status: 'member' as const, user } : member;
  });
}

function persistedChat(app: SmokeApp, id = chatId) {
  const config = readConfig(app.config.configPath);
  return Object.values(config.instances).flatMap(instance => instance.chats).find(chat => chat.botId === botId && chat.chatId === id)!;
}

function replyTarget(user = grace) {
  return { message_id: 900, date: 1, chat: { id: chatId, type: 'supergroup' }, from: user, text: 'Please promote me' };
}


test('topic promotion permits local prompts and delegation but cannot escalate into General or another topic', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Delegated topic' } });
    await app.update({ message_thread_id: 43, forum_topic_created: { name: 'Other topic' } });
    await app.update({ text: '/make_admin @GrAcE', message_thread_id: 42 });
    assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), grace.id, grace.username), true);
    assert.equal(Object.hasOwn(persistedChat(app), 'topic_admins'), false);
    assert.equal(readConfig(app.config.configPath).bots[0]!.admins, undefined);
    for (const threadId of [undefined, 1, 43]) {
      await app.update({ text: '/make_admin alan', message_thread_id: threadId }, grace);
      assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), alan.id, alan.username), false);
      assert.equal(readConfig(app.config.configPath).bots[0]!.admins, undefined);
    }
    await app.update({ text: '/p Not authorized in this topic', message_thread_id: 43 }, grace);
    assert.equal(app.connectionCount, 0);
    await app.update({ text: '/make_admin ALAN', message_thread_id: 42 }, grace);
    assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), alan.id, alan.username), true);
    assert.equal(Object.hasOwn(persistedChat(app), 'topic_admins'), false);
    await app.update({ text: '/p Delegated topic task', message_thread_id: 42 }, alan);
    await app.update({ text: '/p Delegated topic task', message_thread_id: 42 }, alan);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Delegated topic task'));
    await app.update({ text: '/p Still unauthorized elsewhere', message_thread_id: 43 }, alan);
    await app.update({ text: '/new Cannot create another topic' }, alan);
    assert.equal(app.accepted.some(frame => frame.t === 'prompt' && frame.text === 'Still unauthorized elsewhere'), false);
    assert.equal(app.store.listSessions(botId).some(session => session.threadId !== 42 && session.threadId !== 43), false);
  } finally { await app.close(); }
});

test('a topic administrator has no authority in the same numbered topic of another chat', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    const path = Object.keys(app.config.instances)[0]!;
    app.config.instances[path]!.chats.push({ botId, chatId: otherChat.id });
    writeConfig(app.config);
    await app.update({ text: '/setup' });
    await app.update({ text: '/setup', chat: otherChat });
    await app.update({ text: '/make_admin grace', message_thread_id: 42 });
    await app.update({ text: '/make_admin @alan', message_thread_id: 42, chat: otherChat }, grace);
    assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), grace.id, grace.username), true);
    assert.equal(app.store.isTopicAdmin(botId, topicDestination(otherChat.id, 42), alan.id, alan.username), false);
    assert.equal(Object.hasOwn(persistedChat(app), 'topic_admins'), false);
    assert.equal(Object.hasOwn(persistedChat(app, otherChat.id), 'topic_admins'), false);
    assert.equal(readConfig(app.config.configPath).bots[0]!.admins, undefined);
  } finally { await app.close(); }
});

for (const target of ['left', 'kicked', 'restricted-inactive', 'bot'] as const) {
  test(`promotion refuses a ${target} target without changing persisted privileges`, async t => {
    const app = await createSmokeApp();
    try {
      const original = app.bot.api.getChatMember.bind(app.bot.api);
      t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
        if (args[1] !== grace.id) return original(...args);
        const user = { ...grace, is_bot: target === 'bot' };
        if (target === 'restricted-inactive') {
          return { status: 'restricted' as const, user, is_member: false, until_date: 0, can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false };
        }
        if (target === 'kicked') return { status: 'kicked' as const, user, until_date: 0 };
        return { status: target === 'left' ? 'left' as const : 'member' as const, user };
      });
      await app.update({ text: '/setup' });
      const before = readConfig(app.config.configPath);
      await app.update({ text: '/make_admin', reply_to_message: replyTarget() });
      await app.update({ text: '/make_admin', message_thread_id: 42, reply_to_message: replyTarget() });
      assert.deepEqual(readConfig(app.config.configPath), before);
      assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), grace.id, grace.username), false);
    } finally { await app.close(); }
  });
}

test('malformed promotion input does not persist administrator privileges', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    await app.update({ text: '/setup' });
    const before = readConfig(app.config.configPath);
    for (const text of ['/make_admin', '/make_admin @@grace', '/make_admin grace-name', '/make_admin @', `/make_admin ${'a'.repeat(33)}`, `/make_admin ${grace.id}`, '/make_admin 0', '/make_admin -20', '/make_admin 1.5', '/make_admin grace alan', '/make_admin 9007199254740992']) {
      await app.update({ text });
      assert.deepEqual(readConfig(app.config.configPath), before, text);
    }
    await app.update({ text: '/make_admin', reply_to_message: { message_id: 901, date: 1, chat: { id: chatId, type: 'supergroup' }, sender_chat: { id: chatId, type: 'supergroup' }, text: 'Anonymous message' } });
    assert.deepEqual(readConfig(app.config.configPath), before);
  } finally { await app.close(); }
});

test('a Telegram membership lookup failure retains the original error details', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    const before = readConfig(app.config.configPath);
    const failure = new GrammyError('Member lookup failed', { ok: false, error_code: 400, description: 'Bad Request: original promotion member lookup failure' }, 'getChatMember', { chat_id: chatId, user_id: grace.id });
    const original = app.bot.api.getChatMember.bind(app.bot.api);
    t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
      if (args[1] === grace.id) throw failure;
      return original(...args);
    });
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    await app.update({ text: '/make_admin', message_thread_id: 42, reply_to_message: replyTarget() });
    assert.deepEqual(readConfig(app.config.configPath), before);
    assert.ok(errors.some(args => args.includes(failure)), 'the original GrammyError reaches error reporting');
    assert.ok(app.messages.some(message => String(message.text).includes(failure.description)), 'the Telegram description reaches the user unchanged');
  } finally { await app.close(); }
});

test('an ordinary active member cannot promote themselves or another member', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    await app.update({ text: '/setup' });
    const before = readConfig(app.config.configPath);
    for (const threadId of [undefined, 1, 42]) {
      await app.update({ text: '/make_admin grace', message_thread_id: threadId }, grace);
      await app.update({ text: '/make_admin', message_thread_id: threadId, reply_to_message: replyTarget(alan) }, grace);
      assert.deepEqual(readConfig(app.config.configPath), before);
      assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), grace.id, grace.username), false);
      assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), alan.id, alan.username), false);
    }
  } finally { await app.close(); }
});

test('username promotions normalize and deduplicate persisted grants', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    app.config.bots[0]!.admins = ['grace'];
    writeConfig(app.config);
    await app.update({ text: '/make_admin @ALAN', message_thread_id: 42 });
    assert.deepEqual(readConfig(app.config.configPath).bots[0]!.admins, ['grace']);
    assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), alan.id, alan.username), true);
    assert.equal(Object.hasOwn(persistedChat(app), 'topic_admins'), false);
  } finally { await app.close(); }
});

for (const status of ['left', 'kicked'] as const) {
  test(`a ${status} username administrator cannot prompt or delegate`, async t => {
    const app = await createSmokeApp();
    try {
      mockMembers(t, app);
      await app.update({ text: '/setup' });
      await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Delegated topic' } });
      app.config.bots[0]!.admins = ['grace'];
      writeConfig(app.config);
      await app.update({ text: '/make_admin grace', message_thread_id: 42 });
      const before = readConfig(app.config.configPath);
      const original = app.bot.api.getChatMember.bind(app.bot.api);
      t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
        if (args[1] === grace.id) return { status, user: grace, until_date: 0 };
        return original(...args);
      });
      for (const threadId of [undefined, 1, 42]) {
        await app.update({ text: '/make_admin alan', message_thread_id: threadId }, grace);
        await app.update({ text: '/p Inactive administrator task', message_thread_id: threadId }, grace);
      }
      await app.update({ text: '/new Inactive administrator topic' }, grace);
      assert.deepEqual(readConfig(app.config.configPath), before);
      assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), alan.id, alan.username), false);
      assert.equal(app.connectionCount, 0);
      assert.deepEqual(app.store.listSessions(botId).map(session => session.threadId), [42]);
    } finally { await app.close(); }
  });
}

test('a topic reply promotion grants the stable numeric ID without changing config', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    await app.update({ text: '/setup' });
    const before = readConfig(app.config.configPath);
    await app.update({ text: '/make_admin', message_thread_id: 42, reply_to_message: replyTarget() });
    assert.deepEqual(readConfig(app.config.configPath), before);
    const destination = topicDestination(chatId, 42);
    assert.equal(app.store.isTopicAdmin(botId, destination, grace.id, 'renamed_grace'), true);
    assert.equal(app.store.isTopicAdmin(botId, destination, alan.id, grace.username), false);
  } finally { await app.close(); }
});

for (const target of [grace.id, grace.username]) {
  test(`a ${typeof target} topic grant survives reopening its SQLite store`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-topic-admin-'));
    const filename = join(directory, 'telegram.sqlite');
    const destination = topicDestination(chatId, 42);
    let store = new Store(filename);
    try {
      store.addTopicAdmin(botId, destination, target);
      store.addTopicAdmin(botId, destination, target);
      store.close();
      store = new Store(filename);
      assert.equal(store.isTopicAdmin(botId, destination, grace.id, grace.username), true);
      assert.equal(store.isTopicAdmin(botId, destination, alan.id, alan.username), false);
      assert.equal(store.isTopicAdmin(botId + 1, destination, grace.id, grace.username), false);
      assert.equal(store.isTopicAdmin(botId, topicDestination(otherChat.id, 42), grace.id, grace.username), false);
      assert.equal(store.isTopicAdmin(botId, topicDestination(chatId, 43), grace.id, grace.username), false);
      if (typeof target === 'number') {
        assert.equal(store.isTopicAdmin(botId, destination, grace.id, 'renamed_grace'), true);
      } else {
        assert.equal(store.isTopicAdmin(botId, destination, grace.id, 'renamed_grace'), false);
      }
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
