import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { Bot, HttpError } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import { installTelegramErrors, redactTelegramFailure } from '../src/telegram-errors.js';

test('native Telegram transport failures retain method and socket diagnostics without exposing the token', {timeout: 10000}, async t => {
  const token = '123456789:boundary-test-token-not-a-real-credential';
  // TCP port zero cannot have a listening service. Exercise an actual failed connection, not a fabricated Bot API response.
  const bot = new Bot(token, {client: {apiRoot: 'http://127.0.0.1:0'}});
  installTelegramErrors(bot, token);
  const controller = new TelegramAbortController();
  const abort = () => controller.abort();
  t.signal.addEventListener('abort', abort, {once: true});
  try {
    await assert.rejects(bot.api.getMe(controller.signal), error => {
      assert.ok(error instanceof HttpError);
      assert.ok(error.error instanceof Error && 'code' in error.error);
      assert.equal(error.error.code, 'ECONNREFUSED');
      assert.ok(error.message.includes('getMe'));
      assert.ok(error.message.includes(error.error.message));
      assert.ok(!inspect(error, {depth: null}).includes(token));
      return true;
    });
  } finally { t.signal.removeEventListener('abort', abort); }
});

test('redaction preserves native cancellation identity and handles getter-only diagnostic messages', () => {
  const token = '123456789:boundary-test-token-not-a-real-credential';
  const signal = AbortSignal.abort();
  const reason = signal.reason;
  const originalMessage = reason.message;
  redactTelegramFailure(reason, token);
  assert.equal(signal.reason, reason);
  assert.equal(reason.message, originalMessage);

  const native = new DOMException(`Native cancellation for ${token}`, 'AbortError');
  const transport = new HttpError('Native transport failed', native);
  redactTelegramFailure(transport, token);
  assert.equal(transport.error, native);
  assert.ok(native instanceof DOMException);
  assert.equal(native.name, 'AbortError');
  assert.ok(native.message.includes('[redacted bot token]'));
  assert.ok(!inspect(transport, {depth: null}).includes(token));
});
