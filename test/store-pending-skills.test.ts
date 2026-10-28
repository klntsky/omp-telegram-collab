import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type PendingSkillKey } from '../src/store.js';

const key: PendingSkillKey = { botId: 1, chatId: -100, threadId: 0, userId: 42 };

test('pending skills deduplicate in selection order without requiring a session', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.getPendingSkills(key), []);
    assert.deepEqual(store.addPendingSkill(key, 'zebra'), ['zebra']);
    assert.deepEqual(store.addPendingSkill(key, 'alpha'), ['zebra', 'alpha']);
    assert.deepEqual(store.addPendingSkill(key, 'zebra'), ['zebra', 'alpha']);
    const skills = store.getPendingSkills(key);
    skills.push('local-only');
    assert.deepEqual(store.getPendingSkills(key), ['zebra', 'alpha']);
    store.clearPendingSkills(key);
    store.clearPendingSkills(key);
    assert.deepEqual(store.getPendingSkills(key), []);
    assert.deepEqual(store.addPendingSkill(key, 'alpha'), ['alpha']);
  } finally {
    store.close();
  }
});

test('pending skills isolate every identity field including General and clear only the selected identity', () => {
  const store = new Store(':memory:');
  const others: PendingSkillKey[] = [
    { ...key, botId: 2 },
    { ...key, chatId: -200 },
    { ...key, threadId: 17 },
    { ...key, userId: 43 },
  ];
  try {
    store.addPendingSkill(key, 'general');
    for (const [index, other] of others.entries()) {
      assert.deepEqual(store.getPendingSkills(other), []);
      store.addPendingSkill(other, `other-${index}`);
    }
    assert.deepEqual(store.getPendingSkills(key), ['general']);
    store.clearPendingSkills(key);
    assert.deepEqual(store.getPendingSkills(key), []);
    for (const [index, other] of others.entries()) {
      assert.deepEqual(store.getPendingSkills(other), [`other-${index}`]);
    }
  } finally {
    store.close();
  }
});

test('pending skill order and clearing persist across store restarts independently of sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-pending-skills-'));
  const filename = join(directory, 'topics.sqlite');
  try {
    const first = new Store(filename);
    try {
      first.addPendingSkill(key, 'zebra');
      first.addPendingSkill(key, 'alpha');
      first.addPendingSkill(key, 'zebra');
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.deepEqual(second.getPendingSkills(key), ['zebra', 'alpha']);
      assert.equal(second.getTopic(key), undefined);
      const session = second.createSession({ ...key, instancePath: '/work/project' }, 'Session');
      second.updateSession(session.id, { status: 'closed' });
      assert.deepEqual(second.getPendingSkills(key), ['zebra', 'alpha']);
      second.clearPendingSkills(key);
    } finally {
      second.close();
    }
    const third = new Store(filename);
    try {
      assert.deepEqual(third.getPendingSkills(key), []);
    } finally {
      third.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
