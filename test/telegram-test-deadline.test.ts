import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withTelegramTestDeadline } from '../scripts/lib/telegram-test-deadline.js';

test('deadline cancels underlying work and bounds an operation ignoring cancellation', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(withTelegramTestDeadline('stalled provision', 5, new AbortController().signal, async scope => {
    signal = scope;
    return new Promise<never>(() => undefined);
  }), /stalled provision timed out after 5ms/);
  assert.equal(signal?.aborted, true);
});

test('parent cancellation preserves its exact reason', async () => {
  const parent = new AbortController();
  const reason = new Error('Original parent diagnostic');
  let signal: AbortSignal | undefined;
  const pending = withTelegramTestDeadline('parent', 1000, parent.signal, async scope => {
    signal = scope;
    return new Promise<never>(() => undefined);
  });
  await Promise.resolve();
  parent.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(signal?.reason, reason);
});

test('late operation rejection is observed after deadline completion', async () => {
  const late = Promise.withResolvers<void>();
  await assert.rejects(withTelegramTestDeadline('late failure', 5, new AbortController().signal, () => late.promise), /late failure/);
  late.reject(new Error('Late original failure'));
  await delay(5);
});

test('successful deadlines dispose timers and detach parent cancellation', async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const result = await withTelegramTestDeadline('success', 5, parent.signal, async scope => {
    signal = scope;
    return 42;
  });
  assert.equal(result, 42);
  parent.abort(new Error('Unrelated later parent cancellation'));
  await delay(15);
  assert.equal(signal?.aborted, false);
});

test('operation failures preserve the original diagnostic and cancel its scope', async () => {
  const reason = new Error('Original service rejection');
  let signal: AbortSignal | undefined;
  await assert.rejects(withTelegramTestDeadline('failed request', 1000, new AbortController().signal, async scope => {
    signal = scope;
    throw reason;
  }), error => error === reason);
  assert.equal(signal?.reason, reason);
});
