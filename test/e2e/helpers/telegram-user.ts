import { tl, type TelegramClient, type User } from '@mtcute/node';
import { forkTelegramTestSession, type TelegramTestSession } from '../../../scripts/lib/telegram-test-sessions.js';
import { acquireTelegramTestBot } from '../../../scripts/lib/telegram-test-bots.js';

export class TelegramTestUser {
  readonly client: TelegramClient;
  readonly signal: AbortSignal;
  account!: User;
  readonly #controller = new AbortController();
  readonly #session: TelegramTestSession;
  #closing?: Promise<void>;
  private constructor(session: TelegramTestSession, signal?: AbortSignal) {
    this.#session = session;
    this.client = session.client;
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
  }
  static async connect(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TelegramTestUser> {
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 60000)]);
    signal.throwIfAborted();
    const session = await forkTelegramTestSession(signal);
    const user = new TelegramTestUser(session, options.signal);
    const abort = () => { void user.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); user.account = await user.client.getMe(); signal.throwIfAborted(); return user; }
    catch (error) { await user.close(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  call<T extends tl.RpcMethod>(request: T, signal: AbortSignal = this.signal): Promise<tl.RpcCallReturn[T['_']]> {
    signal.throwIfAborted();
    return this.client.call(request, { abortSignal: signal, timeout: 30000, maxRetryCount: 0, floodSleepThreshold: 0 });
  }
  acquireBot() {
    return acquireTelegramTestBot(this.signal);
  }
  close(): Promise<void> {
    this.#closing ??= this.#session.close().finally(() => this.#controller.abort(new Error('Telegram test user closed')));
    return this.#closing;
  }
}
