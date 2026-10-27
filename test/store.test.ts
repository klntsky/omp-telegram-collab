import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { botId, chatId } from './telegram-data.js';

const topic = { botId, chatId, threadId: 17 };

test('topic identity survives a service restart and closing preserves its history binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-telegram-store-'));
  const filename = join(dir, 'topics.sqlite');
  try {
    const first = new Store(filename);
    first.enrollGroup(botId, chatId);
    const original = first.createSession(topic, 'Implement auth', { kind: 'attached', instanceId: 'instance-a', sessionId: 'omp-session-a' });
    first.updateSession(original.id, { status: 'closed', name: 'Authentication complete' });
    first.close();
    const second = new Store(filename);
    try {
      assert.equal(second.isEnrolled(botId, chatId), true);
      const restored = second.getTopic(topic);
      assert.equal(restored?.id, original.id);
      assert.equal(restored?.status, 'closed');
      assert.equal(restored?.name, 'Authentication complete');
      assert.deepEqual(restored?.runtime, { kind: 'attached', instanceId: 'instance-a', sessionId: 'omp-session-a' });
      second.updateSession(original.id, { status: 'open' });
      assert.equal(second.getSession(original.id)?.status, 'open');
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one bot and topic tuple cannot acquire two session identities', () => {
  const store = new Store(':memory:');
  try {
    const original = store.createSession(topic, 'Original');
    try {
      store.createSession(topic, 'Duplicate service update');
    } catch {
      assert.equal(store.getTopic(topic)?.id, original.id);
    }
    assert.equal(store.getTopic(topic)?.id, original.id);
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
