import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { telegramTestTimeouts } from '../scripts/lib/telegram-test-deadline.js';
import { acquireTelegramTestLock, withTelegramTestLock } from '../scripts/lib/telegram-test-lock.js';

const moduleUrl = new URL('../scripts/lib/telegram-test-lock.ts', import.meta.url).href;

test('native flock remains owned after acquisition subprocess exits, across OS processes', async () => {
  const name = `test:${randomUUID()}`;
  const signal = new AbortController().signal;
  const release = await acquireTelegramTestLock(name, signal);
  assert(release);
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { acquireTelegramTestLock } from ${JSON.stringify(moduleUrl)};
      const release = await acquireTelegramTestLock(${JSON.stringify(name)}, new AbortController().signal, true);
      if (release) { await release(); process.exitCode = 1; }
    `], { stdio: ['ignore', 'ignore', 'inherit'] });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(await acquireTelegramTestLock(name, signal, true), undefined);
  } finally { await release(); }
  const next = await acquireTelegramTestLock(name, signal, true);
  assert(next);
  await next();
});

test('blocked acquisition cancellation releases its descriptor and preserves abort reason', async () => {
  const name = `test:${randomUUID()}`;
  const controller = new AbortController();
  const release = await acquireTelegramTestLock(name, new AbortController().signal);
  assert(release);
  const reason = new Error('cancel lock wait');
  const pending = acquireTelegramTestLock(name, controller.signal);
  await delay(100);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(await acquireTelegramTestLock(name, new AbortController().signal, true), undefined, 'cancellation must preserve the owner lock');
  await release();
  await withTelegramTestLock(name, new AbortController().signal, async () => {
    assert.equal(await acquireTelegramTestLock(name, new AbortController().signal, true), undefined);
  });
});

test('process exit releases the acquired native lock', async () => {
  const name = `test:${randomUUID()}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { acquireTelegramTestLock } from ${JSON.stringify(moduleUrl)};
    await acquireTelegramTestLock(${JSON.stringify(name)}, new AbortController().signal);
    process.stdout.write('locked');
    process.stdin.resume();
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await once(child.stdout, 'data');
    assert.equal(await acquireTelegramTestLock(name, new AbortController().signal, true), undefined);
  } finally { child.kill('SIGKILL'); await once(child, 'exit'); }
  const release = await acquireTelegramTestLock(name, new AbortController().signal, true);
  assert(release);
  await release();
});

test('contended blocking locks time out after the fixed lease budget and redact sensitive identities', { timeout: 20_000 }, async () => {
  const names = [`session:secret-auth-key:${randomUUID()}`, `bot:${Date.now()}`];
  await Promise.all(names.map(async name => {
    const signal = new AbortController().signal;
    const owner = await acquireTelegramTestLock(name, signal);
    assert(owner);
    try {
      const started = performance.now();
      await assert.rejects(acquireTelegramTestLock(name, signal), error => {
        assert(error instanceof Error);
        assert.match(error.message, /Telegram test lock/);
        if (name.startsWith('bot:')) assert(error.message.includes(name));
        else {
          assert(!error.message.includes(name));
          assert(!error.message.includes('secret-auth-key'));
          assert.match(error.message, /sha256:[a-f0-9]{64}/);
        }
        return true;
      });
      assert(performance.now() - started >= telegramTestTimeouts.lease - 100);
      assert(performance.now() - started < telegramTestTimeouts.lease + 5_000);
      assert.equal(await acquireTelegramTestLock(name, signal, true), undefined, 'timed out waiter must not release the owner');
    } finally {
      await owner();
    }
    const later = await acquireTelegramTestLock(name, signal);
    assert(later, 'a timed out waiter must not retain the lock after the owner releases it');
    await later();
  }));
});

test('lock callbacks retain their original failure and release ownership', async () => {
  const name = `test:${randomUUID()}`;
  const signal = new AbortController().signal;
  const failure = new Error('original operation diagnostic');
  await assert.rejects(withTelegramTestLock(name, signal, async () => { throw failure; }), error => error === failure);
  const later = await acquireTelegramTestLock(name, signal, true);
  assert(later);
  await later();
});
