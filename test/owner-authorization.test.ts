import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';

const owner = { id: ownerId, first_name: 'Ada', username: ownerUsername, is_bot: false };

test('enrollment follows the case-insensitive current instance admin username, not the update username or numeric ID', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({ username: ownerUsername.toUpperCase() });
    await app.update({ text: '/setup' }, { ...owner, id: ownerId + 1, username: 'stale_nonowner' });
    assert.equal(app.store.isEnrolled(botId, chatId), true);
  } finally {
    await app.close();
  }
});

for (const username of [undefined, 'another_admin']) {
  test(`enrollment denies current username ${username ?? '(missing)'} despite a stale instance admin update and the same numeric ID`, async () => {
    const app = await createSmokeApp();
    try {
      app.setCurrentMember({ username });
      await app.update({ text: '/setup' }, owner);
      assert.equal(app.store.isEnrolled(botId, chatId), false);
    } finally {
      await app.close();
    }
  });
}

for (const member of [
  { username: ownerUsername, is_bot: true },
]) {
  test('enrollment denies a configured username whose current holder is a bot', async () => {
    const app = await createSmokeApp();
    try {
      app.setCurrentMember(member);
      await app.update({ text: '/setup' }, owner);
      assert.equal(app.store.isEnrolled(botId, chatId), false);
    } finally {
      await app.close();
    }
  });
}

test('setup callbacks use the current member username instead of the callback actor username', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({ username: 'another_admin' });
    await app.bot.handleUpdate({
      update_id: 1000,
      callback_query: {
        id: 'setup-check', chat_instance: 'fixture-chat', from: owner, data: 'setup:check',
        message: { message_id: 1, date: 1, chat: { id: chatId, type: 'supergroup', title: 'Fixture project', is_forum: true }, text: 'Check Again' },
      },
    });
    assert.equal(app.store.isEnrolled(botId, chatId), false);
  } finally {
    await app.close();
  }
});

test('attachment follows the current instance administrator username without granting privileges to a stale identity', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    for (const member of [
      {},
      { username: 'another_admin' },
    ]) {
      app.setCurrentMember(member);
      await app.update({ text: '/attach local-instance Denied attachment' }, owner);
      assert.equal(app.store.listSessions(botId).length, 0);
    }
    app.setCurrentMember({ username: ownerUsername, is_bot: true });
    await app.update({ text: '/attach local-instance Denied bot attachment' }, owner);
    assert.equal(app.store.listSessions(botId).length, 0);

    app.setCurrentMember({ username: ownerUsername.toUpperCase(), status: 'member' });
    await app.update({ text: '/attach local-instance Current owner attachment' }, { ...owner, id: ownerId + 1, username: 'stale_nonowner' });
    const sessions = app.store.listSessions(botId);
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.runtime, { kind: 'attached', instanceId: 'local-instance', sessionId: 'attached-conversation' });
  } finally {
    await app.close();
  }
});

test('an ordinary member retains session access but cannot prompt by default', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    app.setCurrentMember({ status: 'member' });
    const member = { id: ownerId + 2, first_name: 'Grace', is_bot: false };
    await app.service.authorize(chatId, member.id);
    const before = app.messages.length;
    await app.update({ text: '/new' }, member);
    assert.equal(app.messages.length,before);
    assert.deepEqual(app.store.listSessions(botId),[]);
    app.setMember(false);
    await assert.rejects(app.service.authorize(chatId, member.id));
  } finally {
    await app.close();
  }
});

test('private onboarding uses the actor username from the union of this bot’s instance admins', async () => {
  const app = await createSmokeApp();
  try {
    for (const username of [undefined, 'another_admin']) {
      await app.update({ text: '/start', chat: { id: ownerId, type: 'private', first_name: 'Ada' } }, { ...owner, username });
      assert.equal(app.messages.at(-1)?.reply_markup, undefined);
    }
    await app.update({ text: '/start', chat: { id: ownerId + 1, type: 'private', first_name: 'Ada' } }, { ...owner, id: ownerId + 1, username: ownerUsername.toUpperCase() });
    assert.ok(app.messages.at(-1)?.reply_markup);
    const beforeBot = app.messages.length;
    await app.update({ text: '/start', chat: { id: ownerId, type: 'private', first_name: 'Ada' } }, { ...owner, is_bot: true });
    assert.equal(app.messages.length, beforeBot);
  } finally {
    await app.close();
  }
});

test('instance admins are isolated by canonical path and bot-chat assignment', async () => {
  const app = await createSmokeApp();
  const directory = await mkdtemp(join(tmpdir(), 'omp-bot-other-path-'));
  const otherPath = realpathSync(directory);
  try {
    const [originalPath] = Object.keys(app.config.instances);
    assert.ok(originalPath);
    const otherChatId = chatId - 1;
    const existingBot = app.config.bots[0]!;
    app.config.bots.push({ ...existingBot, id: botId + 1, token: existingBot.token.replace(/^\d+:/, `${botId + 1}:`) });
    app.config.instances[originalPath]!.chats.push({ botId: botId + 1, chatId: otherChatId });
    app.config.instances[otherPath] = { admins: ['grace'], chats: [{ botId, chatId: otherChatId }, { botId: botId + 1, chatId }] };
    const otherChat = { id: otherChatId, type: 'supergroup', title: 'Other project', is_forum: true };
    await app.update({ text: '/setup' });
    await app.update({ text: '/setup', chat: otherChat });
    assert.equal(app.store.isEnrolled(botId, chatId), true);
    assert.equal(app.store.isEnrolled(botId, otherChatId), false, 'admin of one path is not admin of another');
    app.setCurrentMember({ username: 'GRACE' });
    await app.update({ text: '/setup', chat: otherChat });
    assert.equal(app.store.isEnrolled(botId, otherChatId), true);
    await app.update({ text: '/attach local-instance Wrong path admin' });
    assert.equal(app.store.listSessions(botId).length, 0);
    const attachments: string[] = [];
    const attach = app.runtime.attach.bind(app.runtime);
    app.runtime.attach = async (id, path) => {
      attachments.push(path);
      return attach(id, path);
    };
    await app.update({ text: '/attach local-instance Other path attachment', chat: otherChat });
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(session.chatId, otherChatId);
    assert.equal(session.instancePath, otherPath);
    assert.deepEqual(attachments, [otherPath]);
    await app.update({ text: '/new Ignored non-admin task' });
    assert.equal(app.store.listSessions(botId).some(session => session.chatId === chatId),false);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.update({ text: '/new Primary path member task' });
    assert.equal(app.store.listSessions(botId).find(session => session.chatId === chatId)?.instancePath, originalPath, 'instance admin prompts still route to their own assigned path');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unbound setup requests require current Telegram administration and transition only after local assignment', async () => {
  const app = await createSmokeApp();
  try {
    const instances = app.config.instances;
    const originalPath = Object.keys(instances)[0]!;
    app.config.instances = {};
    app.config.configPath = "/tmp/operator's config.yaml";
    app.setCurrentMember({ username: 'current_admin', status: 'member' });
    await app.update({ text: '/setup' }, { ...owner, username: 'stale_owner' });
    assert.deepEqual(app.store.listSetupRequests(), []);
    app.setCurrentMember({ username: 'CURRENT_ADMIN', status: 'administrator' });
    const title = 'Project $(touch /tmp/never-run-this)';
    await app.update({ text: '/setup', chat: { id: chatId, type: 'supergroup', title, is_forum: true } }, { ...owner, username: 'stale_owner' });
    const [request] = app.store.listSetupRequests();
    assert.ok(request);
    assert.equal(request.username, 'current_admin');
    assert.equal(request.title, title);
    assert.equal(app.store.isEnrolled(botId, chatId), false);
    const suggestion = String(app.messages.at(-1)?.text);
    assert.ok(suggestion.includes(`omp-telegram --config '/tmp/operator'\\''s config.yaml' approve ${request.code}`));
    assert.equal(suggestion.includes(title), false);
    assert.equal(suggestion.includes(originalPath), false);
    await app.update({ text: '/new Not locally approved' });
    assert.deepEqual(app.store.listSessions(botId), []);
    app.config.instances = { [originalPath]: { admins: ['current_admin'], chats: [{ botId, chatId }] } };
    app.store.consumeSetupRequest(request.code);
    await app.update({ text: '/setup' }, { ...owner, username: 'stale_owner' });
    assert.equal(app.store.isEnrolled(botId, chatId), true);
    assert.equal(app.store.getSetupRequest(request.code), undefined);
    await app.update({ text: '/new Approved path task' });
    assert.equal(app.store.listSessions(botId)[0]?.instancePath, originalPath);
  } finally {
    await app.close();
  }
});

test('a bot without assigned instances gives private setup guidance without exposing directories', async () => {
  const app = await createSmokeApp();
  try {
    const paths = Object.keys(app.config.instances);
    app.config.instances = {};
    await app.update({ text: '/start', chat: { id: ownerId, type: 'private', first_name: 'Visitor' } }, { id: ownerId + 44, first_name: 'Visitor', is_bot: false });
    assert.ok(app.messages.at(-1)?.reply_markup);
    for (const path of paths) assert.equal(String(app.messages.at(-1)?.text).includes(path), false);
  } finally {
    await app.close();
  }
});

test('unbound setup checks bot forum permissions before creating a pending request', async () => {
  const app = await createSmokeApp({ botCanPinMessages: false });
  try {
    app.config.instances = {};
    await app.update({ text: '/setup' });
    assert.deepEqual(app.store.listSetupRequests(), []);
    assert.equal(app.store.isEnrolled(botId, chatId), false);
    assert.match(String(app.messages.at(-1)?.text), /Manage Topics and Pin Messages/);
    assert.equal(String(app.messages.at(-1)?.text).includes(' approve '), false);
  } finally {
    await app.close();
  }
});

