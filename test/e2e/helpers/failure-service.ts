import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { BotService } from '../../../src/bot.js';
import { OmpRuntime } from '../../../src/runtime.js';
import { Store } from '../../../src/store.js';
import type { CollaborationTest } from './collaboration-fixture.js';
import { bounded } from './async.js';
import { cleanupLifecycle } from './lifecycle-cleanup.js';
import { combineTelegramErrors } from './errors.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';

// The normal fixture treats polling rejection as unexpected. These workflows
// deliberately own start() rejection without weakening that fixture's failure gate.
export async function withFailureService(
  app: CollaborationTest,
  signal: AbortSignal,
  run: (owner: { bot: Bot; failure(): Promise<unknown> }) => Promise<void>,
): Promise<void> {
  const store = new Store(join(app.config.dataDir, 'telegram.sqlite'));
  const runtime = new OmpRuntime(app.config);
  const bot = new Bot(app.telegram.bot.token, { client: { environment: 'test', timeoutSeconds: 30 } });
  const service = new BotService({ config: app.config, botConfig: app.config.bots[0]!,
    token: app.telegram.bot.token, store, runtime, bot, topicActivityEmojis: app.topicActivityEmojis });
  const ready = Promise.withResolvers<void>();
  const settled = service.start(() => ready.resolve()).then(
    () => ({ failed: false as const }),
    error => ({ failed: true as const, error }),
  );
  let primary: { error: unknown } | undefined;
  try {
    await bounded(Promise.race([ready.promise, settled.then(result => {
      if (result.failed) throw result.error;
      throw new Error('Failure-test service stopped before readiness');
    })]), signal);
    await run({ bot, async failure() {
      const result = await withTelegramTestDeadline('expected fatal service input', telegramTestTimeouts.expectation,
        signal, scope => bounded(settled, scope));
      assert.ok(result.failed, 'fatal input must reject the service start owner');
      app.omp.log('application.expected-fatal-input', result.error);
      return result.error;
    } });
  } catch (error) {
    primary = { error };
  } finally {
    try {
      await cleanupLifecycle([
        { name: 'failure-test service', run: () => service.close() },
        { name: 'failure-test runtime', run: () => runtime.close() },
        { name: 'failure-test store', run: () => store.close() },
      ], message => app.omp.log('failure-test.cleanup', message));
    } catch (error) {
      primary = { error: primary ? combineTelegramErrors(primary.error, error) : error };
    }
  }
  if (primary) throw primary.error;
}
