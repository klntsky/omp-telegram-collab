import { telegramTestTimeouts } from '../../../scripts/lib/telegram-test-deadline.js';
import { bounded } from './async.js';

export async function cleanupLifecycle(
  operations: Array<{ name: string; run(): unknown | Promise<unknown> }>,
  diagnostic: (message: string) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(
    `Telegram test lifecycle cleanup timed out after ${telegramTestTimeouts.cleanup}ms`,
  )), telegramTestTimeouts.cleanup);
  const errors: unknown[] = [];
  try {
    for (const { name, run } of operations) {
      // Exhausting the shared wait budget must not skip later resource owners;
      // start each cleanup even when only its late failure can be observed.
      const pending = Promise.resolve().then(run);
      void pending.catch(error => {
        if (controller.signal.aborted) {
          diagnostic(`Late ${name} cleanup failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      });
      try {
        await bounded(pending, controller.signal);
      } catch (error) {
        diagnostic(`${name} cleanup failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        errors.push(new Error(`${name} cleanup failed`, { cause: error }));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (errors.length) throw new AggregateError(errors, 'Application lifecycle cleanup failed');
}
