import assert from 'node:assert/strict';
import test from 'node:test';
import TelegramAbortController from 'abort-controller';
import { createTelegramTestApi } from './e2e/helpers/telegram-resources.js';
import { withTelegramTestDeadline } from '../scripts/lib/telegram-test-deadline.js';

test('retry delays exceeding the parent budget retain the original rejection without replay', async () => {
  const rejection = { ok: false as const, error_code: 429, description: 'Original retry diagnostic', parameters: { retry_after: 3600 } };
  let calls = 0;
  await withTelegramTestDeadline('parent', 1000, new AbortController().signal, async signal => {
    const [transform] = createTelegramTestApi('123:synthetic', signal).config.installedTransformers();
    const response = await transform!(async () => { calls++; return rejection; }, 'getMe', {});
    assert.equal(response, rejection);
  });
  assert.equal(calls, 1);
});

test('request cancellation interrupts retry sleep and never replays the rejected request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejection = { ok: false as const, error_code: 429, description: 'Original retry diagnostic', parameters: { retry_after: 10 } };
  const controller = new TelegramAbortController();
  let calls = 0;
  const [transform] = createTelegramTestApi('123:synthetic', new AbortController().signal).config.installedTransformers();
  const requested = Promise.withResolvers<void>();
  const pending = transform!(async () => { calls++; requested.resolve(); setTimeout(() => controller.abort(), 5); return rejection; }, 'getMe', {}, controller.signal);
  await requested.promise;
  await Promise.resolve();
  t.mock.timers.tick(5);
  const response = await pending;
  assert.equal(response, rejection);
  assert.equal(calls, 1);
});
