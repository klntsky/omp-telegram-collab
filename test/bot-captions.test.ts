import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

const photo = [{ file_id: 'photo', file_unique_id: 'photo', width: 100, height: 100 }];

test('caption commands without entities use enrollment and new-session routing', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ photo, caption: '/setup' });
    await app.update({ message_id: 7001, photo, caption: '/new@FixtureOmpBot Inspect this image' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Inspect this image' }]);
    const session = app.store.listSessions(botId)[0]!;
    assert.ok(session);
    assert.ok(app.messages.some(message => message.message_thread_id === session.threadId && message.forwarded_message_id === 7001));
  } finally {
    await app.close();
  }
});

test('caption commands retain bot targeting and forwarded-message exclusions', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ photo, caption: '/new@AnotherBot Ignore this' });
    await app.update({ photo, caption: '/new Ignore forwarded media', forward_origin: { type: 'hidden_user', sender_user_name: 'Someone', date: 1 } });
    assert.deepEqual(app.store.listSessions(botId), []);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), []);
  } finally {
    await app.close();
  }
});
