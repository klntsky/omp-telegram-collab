import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { parseEnv, promisify } from 'node:util';
import { resolveTelegramTestEnvFile } from '../../test/e2e/helpers/telegram-env.js';
import { combineTelegramErrors } from '../../test/e2e/helpers/errors.js';
import { acquireTelegramTestLock } from './telegram-test-lock.js';

export function readTelegramTestBotTokens(env: NodeJS.ProcessEnv): string[] {
  let tokens: unknown;
  try { tokens = JSON.parse(env.TELEGRAM_TEST_BOT_TOKENS ?? 'null'); } catch {
    throw new Error('TELEGRAM_TEST_BOT_TOKENS must be a nonempty JSON array of bot tokens');
  }
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some(token => typeof token !== 'string' || !/^[1-9]\d*:[A-Za-z0-9_-]{30,}$/.test(token))) {
    throw new Error('TELEGRAM_TEST_BOT_TOKENS must be a nonempty JSON array of bot tokens');
  }
  if (new Set(tokens.map(token => token.split(':')[0])).size !== tokens.length) {
    throw new Error('TELEGRAM_TEST_BOT_TOKENS contains duplicate bot identities');
  }
  return tokens;
}

export interface TelegramTestBotLease {
  token: string;
  release(): Promise<void>;
}

const activeLeases = new Set<TelegramTestBotLease>();

export async function acquireTelegramTestBot(signal: AbortSignal, options: { checkoutPath?: string } = {}): Promise<TelegramTestBotLease> {
  signal.throwIfAborted();
  const checkout = await realpath(options.checkoutPath ?? (await promisify(execFile)('git', ['rev-parse', '--show-toplevel'])).stdout.trim());
  const releaseCheckout = await acquireTelegramTestLock(`bot-checkout:${checkout}`, signal);
  try {
    const bot = await acquireBot(signal);
    if (signal.aborted) {
      try { await bot.release(); } catch (cleanup) { throw combineTelegramErrors(signal.reason, cleanup); }
      signal.throwIfAborted();
    }
    let releasing: Promise<void> | undefined;
    const lease: TelegramTestBotLease = { token: bot.token, release() {
      return releasing ??= (async () => {
        await bot.release();
        await releaseCheckout!();
        activeLeases.delete(lease);
      })();
    } };
    activeLeases.add(lease);
    return lease;
  } catch (error) {
    try { await releaseCheckout!(); } catch (cleanup) { throw combineTelegramErrors(error, cleanup); }
    throw error;
  }
}

async function readSavedBotTokens(): Promise<string[]> {
  const file = await open(await resolveTelegramTestEnvFile(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let tokens: string[];
  let readFailure: unknown;
  let readFailed = false;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Refusing to read Telegram test bot tokens from a non-regular or hard-linked file');
    tokens = readTelegramTestBotTokens(parseEnv(await file.readFile('utf8')));
  } catch (error) { readFailure = error; readFailed = true; throw error; } finally {
    try { await file.close(); } catch (cleanup) {
      if (readFailed) throw combineTelegramErrors(readFailure, cleanup);
      throw cleanup;
    }
  }
  return tokens;
}

async function acquireBot(signal: AbortSignal): Promise<TelegramTestBotLease> {
  const tokens = await readSavedBotTokens();
  signal.throwIfAborted();
  const stop = new AbortController();
  const waitingSignal = AbortSignal.any([signal, stop.signal]);
  const waiters = tokens.map(async token => {
    const release = await acquireTelegramTestLock(`bot:${token.split(':')[0]}`, waitingSignal);
    if (!release) throw new Error('Blocking Telegram test bot lock returned without a lease');
    return { token, release };
  });
  let winner: Awaited<typeof waiters[number]> | undefined;
  let failure: unknown;
  let failed = false;
  try { winner = await Promise.race(waiters); } catch (error) { failure = error; failed = true; }
  stop.abort();
  const settled = await Promise.allSettled(waiters);
  const cleanupErrors: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value !== winner) {
      try { await result.value.release(); } catch (error) { cleanupErrors.push(error); }
    }
  }
  if (winner && (cleanupErrors.length || failed || signal.aborted)) {
    try { await winner.release(); } catch (error) { cleanupErrors.push(error); }
  }
  if (signal.aborted) {
    if (cleanupErrors.length) throw combineTelegramErrors(signal.reason, ...cleanupErrors);
    signal.throwIfAborted();
  }
  if (failed) {
    if (cleanupErrors.length) throw combineTelegramErrors(failure, ...cleanupErrors);
    throw failure;
  }
  if (cleanupErrors.length) throw combineTelegramErrors(...cleanupErrors);
  const lease = winner!;
  let token: string;
  try {
    const current = (await readSavedBotTokens()).find(value => value.split(':')[0] === lease.token.split(':')[0]);
    if (!current) throw new Error('Leased Telegram bot was removed from the configured token pool');
    signal.throwIfAborted();
    token = current;
  } catch (error) {
    try { await lease.release(); } catch (cleanup) { throw combineTelegramErrors(error, cleanup); }
    throw error;
  }
  let releasing: Promise<void> | undefined;
  return { token, release() { return releasing ??= lease.release(); } };
}
