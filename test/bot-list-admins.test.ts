import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Bot } from 'grammy';
import type { AppConfig } from '../shared/contracts.js';
import type { Store } from '../src/store.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { writeConfig } from '../src/config.js';
import { topicDestination } from '../shared/topic-destination.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';

interface SmokeApp {
  bot: Bot;
  config: AppConfig;
  store: Store;
  messages: Record<string, unknown>[];
  update(message: Record<string, unknown>, from: { id: number; first_name: string; username: string; is_bot: boolean }): Promise<void>;
}
const member = { id: ownerId + 20, first_name: 'Grace', username: 'grace', is_bot: false };
const numericAdmin = { id: ownerId + 21, first_name: 'Alan', username: 'alan', is_bot: false };
const unnamedAdmin = { id: ownerId + 22, first_name: 'Anonymous', is_bot: false };

function mockMembers(t: TestContext, app: SmokeApp) {
  const original = app.bot.api.getChatMember.bind(app.bot.api);
  t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
    const user = [member, numericAdmin, unnamedAdmin].find(candidate => candidate.id === args[1]);
    return user ? { status: 'member' as const, user } : original(...args);
  });
}

async function list(app: SmokeApp, threadId?: number, text = '/list_admins') {
  const before = app.messages.length;
  await app.update({ text, message_thread_id: threadId }, member);
  return app.messages.slice(before).map(message => String(message.text ?? '')).join('\n');
}

function configureAdmins(app: SmokeApp) {
  app.config.bots[0]!.admins = ['bot_admin', numericAdmin.id];
  const instance = Object.values(app.config.instances)[0]!;
  instance.admins.push('second_root');
  writeConfig(app.config);
  for (const identity of ['local_alpha', ownerUsername, 'bot_admin', numericAdmin.id]) {
    app.store.addTopicAdmin(botId, topicDestination(chatId, 42), identity);
  }
  app.store.addTopicAdmin(botId, topicDestination(chatId, 43), 'local_beta');
  app.store.addTopicAdmin(botId, topicDestination(chatId, 42), unnamedAdmin.id);
  app.store.addTopicAdmin(botId, topicDestination(chatId - 1, 42), 'other_chat_admin');
  app.store.addTopicAdmin(botId + 1, topicDestination(chatId, 42), 'other_bot_admin');
}

for (const threadId of [undefined, 1]) {
  test(`General administrator listing (${threadId ?? 'no thread ID'}) includes this forum's global and topic grants`, async t => {
    const app = await createSmokeApp();
    try {
      mockMembers(t, app);
      configureAdmins(app);
      await app.update({ text: '/setup' });
      const text = await list(app, threadId);
      assert.match(text, /Global admins/);
      for (const username of [ownerUsername, 'second_root', 'bot_admin', 'alan', 'local_alpha', 'local_beta']) {
        assert.ok(text.includes(`@${username}`), username);
        assert.equal(text.split(`@${username}`).length - 1, 1, `${username} is not repeated as a topic admin`);
      }
      assert.ok(text.includes(`https://t.me/c/${String(chatId).replace(/^-100/, '')}/42`));
      assert.ok(text.includes(`https://t.me/c/${String(chatId).replace(/^-100/, '')}/43`));
      assert.ok(text.includes(`User ID: ${unnamedAdmin.id}`));
      assert.doesNotMatch(text, /other_chat_admin|other_bot_admin/);
    } finally { await app.close(); }
  });
}

test('an ordinary active member can list separate global and current-topic administrators', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    configureAdmins(app);
    await app.update({ text: '/setup' });
    const text = await list(app, 42);
    const globalStart = text.indexOf('Global admins');
    const topicStart = text.indexOf('Topic admins');
    assert.ok(globalStart >= 0 && topicStart > globalStart);
    const global = text.slice(globalStart, topicStart);
    const local = text.slice(topicStart);
    for (const username of [ownerUsername, 'second_root', 'bot_admin', 'alan']) {
      assert.ok(global.includes(`@${username}`));
      assert.ok(!local.includes(`@${username}`), `${username} is global, not local`);
    }
    assert.match(local, /@local_alpha/);
    assert.ok(local.includes(`User ID: ${unnamedAdmin.id}`));
    assert.doesNotMatch(text, /local_beta|other_chat_admin|other_bot_admin/);
    const commands = await app.bot.api.getMyCommands({ scope: { type: 'chat', chat_id: chatId } });
    assert.ok(commands.some(command => command.command === 'list_admins'));
  } finally { await app.close(); }
});

test('a numeric reply grant resolving to a global root username is omitted from topic administrators', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    await app.update({ text: '/setup' });
    const rootAlias = { id: ownerId + 100, first_name: 'Root alias', username: ownerUsername, is_bot: false };
    const original = app.bot.api.getChatMember.bind(app.bot.api);
    t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
      return args[1] === rootAlias.id ? { status: 'member' as const, user: rootAlias } : original(...args);
    });
    await app.update({ text: '/make_admin', message_thread_id: 42, reply_to_message: {
      message_id: 900, date: 1, chat: { id: chatId, type: 'supergroup' }, from: rootAlias, text: 'Root reply',
    } });
    assert.equal(app.store.isTopicAdmin(botId, topicDestination(chatId, 42), rootAlias.id), true);
    for (const threadId of [undefined, 42]) {
      const text = await list(app, threadId);
      assert.equal(text.split(`@${ownerUsername}`).length - 1, 1);
      assert.ok(!text.includes(`User ID: ${rootAlias.id}`));
    }
  } finally { await app.close(); }
});

test('list_admins rejects arguments rather than listing administrators', async t => {
  const app = await createSmokeApp();
  try {
    mockMembers(t, app);
    await app.update({ text: '/setup' });
    for (const threadId of [undefined, 42]) {
      const text = await list(app, threadId, '/list_admins @grace');
      assert.match(text, /usage|no arguments|does not accept|takes no/i);
      assert.doesNotMatch(text, /Global admins/);
    }
  } finally { await app.close(); }
});

for (const status of ['left', 'kicked'] as const) {
  test(`a ${status} member cannot list administrators`, async t => {
    const app = await createSmokeApp();
    try {
      mockMembers(t, app);
      await app.update({ text: '/setup' });
      const original = app.bot.api.getChatMember.bind(app.bot.api);
      t.mock.method(app.bot.api, 'getChatMember', async (...args: Parameters<typeof original>) => {
        return args[1] === member.id ? { status, user: member, until_date: 0 } : original(...args);
      });
      for (const threadId of [undefined, 42]) {
        assert.doesNotMatch(await list(app, threadId), /Global admins/);
      }
    } finally { await app.close(); }
  });
}
