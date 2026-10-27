import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';

const owner = { id: ownerId, first_name: 'Ada', username: ownerUsername, is_bot: false };

test('enrollment follows the case-insensitive current owner username, not the update username or numeric ID', async () => {
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
  test(`enrollment denies current username ${username ?? '(missing)'} despite a stale owner update and the same numeric ID`, async () => {
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
  { username: ownerUsername, status: 'member' as const },
  { username: ownerUsername, is_bot: true },
]) {
  test(`enrollment denies a configured username when the current member is ${member.is_bot ? 'a bot' : 'not an administrator'}`, async () => {
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

test('attachment follows the current administrator username without granting privileges to a stale owner identity', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    for (const member of [
      {},
      { username: 'another_admin' },
      { username: ownerUsername, status: 'member' as const },
    ]) {
      app.setCurrentMember(member);
      await app.update({ text: '/attach local-instance Denied attachment' }, owner);
      assert.equal(app.store.listSessions(botId).length, 0);
    }
    app.setCurrentMember({ username: ownerUsername, is_bot: true });
    await app.update({ text: '/attach local-instance Denied bot attachment' }, owner);
    assert.equal(app.store.listSessions(botId).length, 0);

    app.setCurrentMember({ username: ownerUsername.toUpperCase(), status: 'creator' });
    await app.update({ text: '/attach local-instance Current owner attachment' }, { ...owner, id: ownerId + 1, username: 'stale_nonowner' });
    const sessions = app.store.listSessions(botId);
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.runtime, { kind: 'attached', instanceId: 'local-instance', sessionId: 'attached-conversation' });
  } finally {
    await app.close();
  }
});

test('an ordinary current member without a username retains enrolled session access', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    app.setCurrentMember({ status: 'member' });
    const member = { id: ownerId + 2, first_name: 'Grace', is_bot: false };
    await app.service.authorize(chatId, member.id);
    await app.update({ text: '/new' }, member);
    const markup = app.messages.at(-1)?.reply_markup;
    assert.ok(markup && typeof markup === 'object' && 'force_reply' in markup);
    assert.equal(markup.force_reply, true);
    app.setMember(false);
    await assert.rejects(app.service.authorize(chatId, member.id));
  } finally {
    await app.close();
  }
});

test('private onboarding uses the actor username rather than a remembered numeric owner ID', async () => {
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

