import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStorage, TelegramClient, tl, type User } from '@mtcute/node';
import { readStringSession } from '@mtcute/node/utils.js';
import { combineTelegramErrors } from './errors.js';

export interface TelegramApplicationCredentials {
  apiId: number;
  apiHash: string;
}

export interface TelegramTestCredentials extends TelegramApplicationCredentials {
  session: string;
}

export function readTelegramApplicationCredentials(env: NodeJS.ProcessEnv = process.env): TelegramApplicationCredentials {
  const apiId = Number(env.TELEGRAM_TEST_API_ID);
  const apiHash = env.TELEGRAM_TEST_API_HASH;
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('Set TELEGRAM_TEST_API_ID and TELEGRAM_TEST_API_HASH from https://my.telegram.org/apps to run Telegram test-network tests');
  }
  return { apiId, apiHash };
}

export function validateTelegramTestSession(session: string): void {
  const data = readStringSession(session);
  if (!data.primaryDcs.main.testMode || !data.primaryDcs.media.testMode) {
    throw new Error('Refusing to import a Telegram session outside the test network');
  }
  if (data.self?.isBot) throw new Error('Telegram test provisioning requires a user session, not a bot session');
}

export function readTelegramTestCredentials(env: NodeJS.ProcessEnv = process.env): TelegramTestCredentials {
  const application = readTelegramApplicationCredentials(env);
  const session = env.TELEGRAM_TEST_SESSION;
  if (!session) throw new Error('Run pnpm telegram:test:login to save TELEGRAM_TEST_SESSION in .env before running live tests');
  validateTelegramTestSession(session);
  return { ...application, session };
}

export function createTelegramTestClient(credentials: TelegramApplicationCredentials): TelegramClient {
  return new TelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage: new MemoryStorage(),
    testMode: true,
  });
}

export class TelegramTestUser {
  readonly client: TelegramClient;
  readonly signal: AbortSignal;
  account!: User;
  readonly #controller = new AbortController();
  #closing?: Promise<void>;

  private constructor(credentials: TelegramApplicationCredentials, signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    this.client = createTelegramTestClient(credentials);
  }

  static async login(credentials: TelegramTestCredentials, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TelegramTestUser> {
    validateTelegramTestSession(credentials.session);
    const user = new TelegramTestUser(credentials, options.signal);
    const signal = AbortSignal.any([user.signal, AbortSignal.timeout(options.timeoutMs ?? 60000)]);
    const closeOnAbort = () => { void user.close().catch(error => user.client.onError.emit(error)); };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      signal.throwIfAborted();
      await user.client.importSession(credentials.session);
      const config = await user.call({ _: 'help.getConfig' }, signal);
      if (!config.testMode) throw new Error('Refusing to authorize a test account outside the Telegram test network');
      user.account = await user.client.getMe();
      if (user.account.isBot) throw new Error('Telegram test provisioning requires a user session, not a bot session');
      await user.client.notifyLoggedIn(user.account.raw);
      signal.throwIfAborted();
      return user;
    } catch (error) {
      try { await user.close(); } catch (cleanupError) {
        throw combineTelegramErrors(error, cleanupError);
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
    }
  }

  async call<T extends tl.RpcMethod>(request: T, signal: AbortSignal = this.signal): Promise<tl.RpcCallReturn[T['_']]> {
    for (;;) {
      signal.throwIfAborted();
      try {
        return await this.client.call(request, { abortSignal: signal, timeout: 30000, maxRetryCount: 0, floodSleepThreshold: 0 });
      } catch (error) {
        if (!tl.RpcError.is(error, 'FLOOD_WAIT_%d') && !tl.RpcError.is(error, 'FLOOD_TEST_PHONE_WAIT_%d')) throw error;
        await delay(error.seconds * 1000, undefined, { signal });
      }
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      this.#closing = promise;
      this.#controller.abort(new Error('Telegram test user closed'));
      void this.client.destroy().then(resolve, reject);
    }
    return this.#closing;
  }
}
