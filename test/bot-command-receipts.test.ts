import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { readConfig } from '../src/config.js';
import { botId, chatId } from './telegram-data.js';
import { clickSettings } from './bot-test-helpers.js';

test('local commands bypass delivery reactions and settings remain usable', async () => {
  const app = await createSmokeApp();
  let reactionAttempts = 0;
  app.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === 'setMessageReaction') reactionAttempts++;
    return previous(method, payload, signal);
  });
  try {
    await app.update({text:'/setup'});
    for (const command of ['settings', 'help', 'status', 'skills', 'cli', 'session', 'list_admins']) {
      await app.update({text:`/${command}`});
    }
    await app.update({text:'/settings'});
    await clickSettings(app, 0);
    await clickSettings(app, 1);
    const config = readConfig(app.config.configPath);
    const chat = Object.values(config.instances).flatMap(instance => instance.chats)
      .find(chat => chat.botId === botId && chat.chatId === chatId)!;
    assert.equal(chat.all_messages_are_prompts, false);
    assert.equal(reactionAttempts, 0);
    assert.deepEqual(app.accepted, []);
  } finally { await app.close(); }
});
