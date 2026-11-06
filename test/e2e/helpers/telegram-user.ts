import { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tl, type TelegramClient, type User } from '@mtcute/node';
import { TelegramTestExecution, type TelegramTestSession } from '../../../scripts/lib/telegram-test-sessions.js';
import { acquireTelegramTestBot } from '../../../scripts/lib/telegram-test-bots.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';
import { combineTelegramErrors } from './errors.js';

let execution = new TelegramTestExecution();
after(() => execution.close(), { timeout: 30000 });

export class TelegramTestUser {
  readonly client: TelegramClient;
  readonly signal: AbortSignal;
  account!: User;
  readonly #controller = new AbortController();
  readonly #session: TelegramTestSession;
  readonly #execution: TelegramTestExecution;
  #cancelled = false;
  #closing?: Promise<void>;
  private constructor(session: TelegramTestSession, owner: TelegramTestExecution, signal?: AbortSignal) {
    this.#execution = owner;
    this.#session = session;
    this.client = session.client;
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
  }
  static async connect(options: { signal?: AbortSignal; authorizationSignal?: AbortSignal; timeoutMs?: number } = {}): Promise<TelegramTestUser> {
    return withTelegramTestDeadline('user authorization', options.timeoutMs ?? telegramTestTimeouts.authorization,
      options.authorizationSignal ?? options.signal ?? new AbortController().signal, async signal => {
        const owner = execution;
        const session = await owner.acquire(signal);
        const user = new TelegramTestUser(session, owner, options.signal);
        const abort = () => { void user.cancelSetup().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          user.account = await withTelegramTestDeadline('user identity', telegramTestTimeouts.request, signal,
            () => user.client.getMe());
          signal.throwIfAborted();
          return user;
        } catch (error) {
          const errors = [error];
          try { await user.cancelSetup(); } catch (cleanup) { errors.push(cleanup); }
          try { await user.close(); } catch (cleanup) { errors.push(cleanup); }
          throw errors.length === 1 ? error : combineTelegramErrors(...errors);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      });
  }
  async call<T extends tl.RpcMethod>(request: T, signal: AbortSignal = this.signal): Promise<tl.RpcCallReturn[T['_']]> {
    const failures: unknown[] = [];
    const deadline = performance.now() + telegramTestTimeouts.request;
    try {
      // Explicit cleanup signals must survive fixture cancellation until rollback ends.
      return await withTelegramTestDeadline(`Telegram ${request._}`, telegramTestTimeouts.request, signal, async bounded => {
        for (;;) {
          bounded.throwIfAborted();
          try {
            return await this.client.call(request, { abortSignal: bounded, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
              maxRetryCount: 0, floodSleepThreshold: 0 });
          } catch (error) {
            if (!tl.RpcError.is(error, 'FLOOD_WAIT_%d') || error.code !== 420
              || !Number.isSafeInteger(error.seconds) || error.seconds <= 0) throw error;
            failures.push(error);
            // Like TDLib's NetQueryDelayer::delay, honor the server's seconds and total budget;
            // only this explicit rejection is safe to repeat, not an ambiguous transport failure.
            // https://github.com/tdlib/td/blob/master/td/telegram/net/NetQueryDelayer.cpp
            console.warn(`Telegram ${request._} account=${this.account.id} FLOOD_WAIT delay=${error.seconds}s`, error);
            const wait = error.seconds * 1000;
            if (wait >= deadline - performance.now()) {
              throw new Error(`Telegram ${request._} account=${this.account.id}: required ${error.seconds}s delay exceeds remaining request budget`);
            }
            await delay(wait, undefined, { signal: bounded });
          }
        }
      });
    } catch (error) {
      throw failures.length ? combineTelegramErrors(...failures, error) : error;
    }
  }
  acquireBot(signal: AbortSignal = this.signal) {
    return acquireTelegramTestBot(signal);
  }
  async cancelSetup(): Promise<void> {
    this.#cancelled = true;
    this.#controller.abort(new Error('Telegram test provisioning cancelled'));
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#controller.abort(new Error('Telegram test fixture user closed'));
      const errors: unknown[] = [];
      try {
        if (this.#cancelled) {
          // Rollback uses this owner's live worker before close; only subsequent
          // fixtures get a fresh owner instead of inheriting its aborted controller.
          if (execution === this.#execution) execution = new TelegramTestExecution();
          await this.#execution.close();
        }
      } catch (error) { errors.push(error); }
      try { await this.#session.close(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw combineTelegramErrors(...errors);
    })();
    return this.#closing;
  }
}
