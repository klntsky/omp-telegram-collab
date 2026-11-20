import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { emptyConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { OmpRuntime } from '../src/runtime.js';
import { TelegramDelivery } from '../src/telegram-delivery.js';
import { TopicMetadataOwners } from '../src/bot/topic-metadata-owners.js';

test('listener invalidation clears a missed retry end without discarding a known failed outcome', () => {
  const store = new Store(':memory:');
  try {
    const config = emptyConfig('/dev/shm/omp-activity-outcome/config.yaml');
    const bot = new Bot('123:fixture');
    const owners = new TopicMetadataOwners({
      options: { config, botConfig: { id: 123, token: '123:fixture' }, token: '123:fixture', store, runtime: new OmpRuntime(config), bot },
      bot, delivery: new TelegramDelivery(), background: new AbortController(),
      isStopped: () => false, sessionAssigned: () => true, sessionObservation: () => ({}),
    });
    const session = store.createSession({ botId: 123, chatId: -100, threadId: 42, instanceId: 1, cwd: '/fixture' }, 'Retry boundary');
    const observation = owners.activityObservation(session);
    observation.turnOutcome = 'retrying';
    observation.value = 'running';
    observation.observedAt = Date.now();
    observation.controller = new AbortController();
    owners.invalidateActivity(session.id);
    assert.equal(observation.turnOutcome, undefined);
    assert.equal(observation.value, 'unknown');
    assert.equal(observation.observedAt, undefined);
    assert.equal(observation.controller.signal.aborted, true);
    assert.equal(observation.revision, 1);
    observation.turnOutcome = 'failed';
    owners.invalidateActivity(session.id);
    assert.equal(observation.turnOutcome, 'failed');
    assert.equal(observation.revision, 2);
  } finally { store.close(); }
});
