import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

const key = { botId: 1, chatId: -100, threadId: 17, instanceId: 1, cwd: '/work/project' };

test('new topic skill snapshots and clears persist across disk restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-new-topic-skill-'));
  const filename = join(directory, 'topics.sqlite');
  let sessionId: string;
  try {
    const first = new Store(filename);
    try {
      const session = first.createSession(key, 'Session');
      sessionId = session.id;
      first.setNewTopicSkill(sessionId, 'persistent-skill');
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.equal(second.getNewTopicSkill(sessionId), 'persistent-skill');
      assert.equal(second.createSession(key, 'Session').id, sessionId);
      assert.equal(second.getNewTopicSkill(sessionId), 'persistent-skill');
      second.clearNewTopicSkill(sessionId);
    } finally {
      second.close();
    }
    const third = new Store(filename);
    try {
      assert.equal(third.getNewTopicSkill(sessionId), undefined);
      assert.equal(third.getSession(sessionId)?.id, sessionId);
    } finally {
      third.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
