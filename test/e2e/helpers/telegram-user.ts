import { after } from 'node:test';
import { tl, type TelegramClient, type User } from '@mtcute/node';
import { TelegramTestExecution, type TelegramTestSession } from '../../../scripts/lib/telegram-test-sessions.js';
import { acquireTelegramTestBot } from '../../../scripts/lib/telegram-test-bots.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';
import { combineTelegramErrors } from './errors.js';

const execution = new TelegramTestExecution();
after(() => execution.close(), { timeout: 30000 });

export class TelegramTestUser {
  readonly client: TelegramClient;
  readonly signal: AbortSignal;
  account!: User;
  readonly #controller = new AbortController();
  readonly #session: TelegramTestSession;
  #cancelled = false;
  #closing?: Promise<void>;
  private constructor(session: TelegramTestSession, signal?: AbortSignal) {
    this.#session = session;
    this.client = session.client;
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
  }
  static async connect(options: { signal?: AbortSignal; authorizationSignal?: AbortSignal; timeoutMs?: number } = {}): Promise<TelegramTestUser> {
    return withTelegramTestDeadline('user authorization', options.timeoutMs ?? telegramTestTimeouts.authorization,
      options.authorizationSignal ?? options.signal ?? new AbortController().signal, async signal => {
        const session = await execution.acquire(signal);
        const user = new TelegramTestUser(session, options.signal);
        const abort = () => { void user.cancelSetup().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          user.account = await withTelegramTestDeadline('user identity', telegramTestTimeouts.request, signal,
            () => user.client.getMe());
          signal.throwIfAborted();
          return user;
        } catch (error) {
          await user.cancelSetup();
          try { await user.close(); }
          catch (cleanup) { throw combineTelegramErrors(error, cleanup); }
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
        }
      });
  }
  call<T extends tl.RpcMethod>(request: T, signal: AbortSignal = this.signal): Promise<tl.RpcCallReturn[T['_']]> {
    signal.throwIfAborted();
    return this.client.call(request, { abortSignal: signal, timeout: 30000, maxRetryCount: 0, floodSleepThreshold: 0 });
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
      try { if (this.#cancelled) await execution.close(); } catch (error) { errors.push(error); }
      try { await this.#session.close(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw combineTelegramErrors(...errors);
    })();
    return this.#closing;
  }
}
