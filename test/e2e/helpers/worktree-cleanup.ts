import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { TopicSession } from '../../../shared/contracts.js';
import type { CollaborationTest } from './collaboration-fixture.js';
import { clickPanel, createManagedTopic, setTopicClosed, waitForPanel } from './telegram-actions.js';

export async function createCleanupWorktree(app: CollaborationTest) {
  const created = await createManagedTopic(app);
  await app.runtime.worktree(created, `e2e-cleanup-${created.id}`);
  app.store.setSessionCwd(created.id, created.cwd);
  const session = app.store.getSession(created.id)!;
  const target = await app.runtime.inspectWorktree(session);
  assert.ok(target);
  return { session, target };
}

export async function closeForConfirmation(app: CollaborationTest, session: TopicSession) {
  let start = app.apiCalls.length;
  await setTopicClosed(app, session, true);
  const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
  start = app.apiCalls.length;
  await clickPanel(app, offer, 0);
  return waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);
}

export function applicationErrors(app: CollaborationTest): unknown[][] {
  const failure = z.object({ event: z.literal('application.console.error'), data: z.array(z.unknown()) });
  return readFileSync(join(app.omp.logDirectory, 'events.jsonl'), 'utf8').split('\n').flatMap(line => {
    if (!line) return [];
    const parsed = failure.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data.data] : [];
  });
}
