import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';
import { clickSettings, eventually } from './bot-test-helpers.js';

test('explicit commands replying to open and closed settings panels create sessions', async () => {
  const app = await createSmokeApp({skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    const panel = app.messages.at(-1)!;
    await app.update({text:'/new@FixtureOmpBot First task',reply_to_message:panel});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const first = app.accepted.find(frame => frame.t === 'prompt');
    assert.ok(first?.t === 'prompt' && first.text.endsWith('\n\nFirst task'));
    await clickSettings(app,-1,panel);
    await app.update({text:'/new Second task',reply_to_message:panel});
    await eventually(() => app.store.listSessions(botId).length === 2);
    const second = app.accepted.filter(frame => frame.t === 'prompt').at(-1);
    assert.ok(second?.t === 'prompt' && second.text.endsWith('\n\nSecond task'));
  } finally { await app.close(); }
});
