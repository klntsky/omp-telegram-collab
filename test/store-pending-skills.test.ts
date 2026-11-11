import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type PendingSkillKey } from '../src/store.js';

const key: PendingSkillKey = { botId: 1, destination: { kind: 'general', chatId: -100 }, userId: 42 };

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
      const session = second.createSession({ botId:key.botId, chatId:key.destination.chatId, threadId:17, instanceId: 1, cwd:'/work/project' }, 'Session');
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
