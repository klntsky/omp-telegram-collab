import type { OmpRuntime } from '../../../src/runtime.js';
import type { Store } from '../../../src/store.js';
import type { TopicSession } from '../../../shared/contracts.js';
import { telegramTestTimeouts } from '../../../scripts/lib/telegram-test-deadline.js';
import { bounded } from './async.js';
import { combineTelegramErrors } from './errors.js';
import { TelegramTestTimeoutError } from '../../../scripts/lib/telegram-test-errors.js';

export async function cleanupSessions(
  runtime: OmpRuntime,
  store: Store,
  sessions: readonly TopicSession[],
  diagnostic: (message: string) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TelegramTestTimeoutError(
    'session cleanup', telegramTestTimeouts.cleanup,
  )), telegramTestTimeouts.cleanup);
  const errors: unknown[] = [];
  try {
    // Start every termination before waiting: Telegram commands would queue
    // behind the update handler whose initial preparation has stalled.
    const pending = sessions.map(session => {
      const operation = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        const record = (name: string, error: unknown) => {
          diagnostic(`${name} failed for session ${session.id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          failures.push(error);
        };
        try {
          store.cancelInitialTask(session.id);
        } catch (error) {
          record('Pending task cancellation', error);
        }
        try {
          store.advanceSessionGeneration(session.id);
        } catch (error) {
          record('Session generation invalidation', error);
        }
        try {
          await runtime.kill(session);
        } catch (error) {
          record('Runtime termination', error);
        }
        if (failures.length) {
          throw new AggregateError(failures, `Session ${session.id} termination failed:\n${failures.map(error => error instanceof Error ? error.message : String(error)).join('\n')}`, { cause: failures[0] });
        }
      });
      void operation.catch(error => {
        if (controller.signal.aborted) {
          diagnostic(`Late cleanup failure for session ${session.id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      });
      return bounded(operation, controller.signal).catch(error => {
        const failure = new Error(`Cleanup failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        diagnostic(`${failure.message}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        errors.push(failure);
      });
    });
    await Promise.all(pending);
  } finally {
    clearTimeout(timer);
  }
  if (errors.length) throw combineTelegramErrors(...errors);
}
