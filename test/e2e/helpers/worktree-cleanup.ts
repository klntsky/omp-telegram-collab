import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { TopicSession } from '../../../shared/contracts.js';
import type { CollaborationTest } from './collaboration-fixture.js';
import { clickPanel, createManagedTopic, setTopicClosed, waitForPanel, type TelegramPanel } from './telegram-actions.js';

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
  const start = app.apiCalls.length;
  await setTopicClosed(app, session, true);
  const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:o:', start, session.threadId);
  return requestCleanupConfirmation(app, session, offer);
}

export async function requestCleanupConfirmation(app: CollaborationTest, session: TopicSession, offer: TelegramPanel) {
  const start = app.apiCalls.length;
  await clickPanel(app, offer, 0);
  return waitForPanel(app, 'worktree-cleanup', 'wtcleanup:c:', start, session.threadId);
}

export async function applicationErrors(app: CollaborationTest): Promise<unknown[][]> {
  const failure = z.object({ event: z.literal('application.console.error'), data: z.array(z.unknown()) });
  await app.omp.flushLogs();
  return (await readFile(join(app.omp.logDirectory, 'events.jsonl'), 'utf8')).split('\n').slice(0, -1).flatMap(line => {
    if (!line) return [];
    const parsed = failure.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data.data] : [];
  });
}
