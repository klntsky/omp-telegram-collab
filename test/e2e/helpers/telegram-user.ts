import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStorage, TelegramClient, tl, type User } from '@mtcute/node';
import { combineTelegramErrors } from './errors.js';

export interface TelegramTestCredentials {
  apiId: number;
  apiHash: string;
  phone?: string;
}

export function readTelegramTestCredentials(env: NodeJS.ProcessEnv = process.env): TelegramTestCredentials {
  const apiId = Number(env.TELEGRAM_TEST_API_ID);
  const apiHash = env.TELEGRAM_TEST_API_HASH;
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('Set TELEGRAM_TEST_API_ID and TELEGRAM_TEST_API_HASH from https://my.telegram.org/apps to run Telegram test-network tests');
  }
  const phone = env.TELEGRAM_TEST_PHONE;
  if (phone !== undefined) testPhone(phone);
  return { apiId, apiHash, phone };
}

function testPhone(value: string): string {
  const phone = value.replace(/^\+/, '');
  if (!/^99966[123]\d{4}$/.test(phone)) throw new Error('Telegram test phone must match 99966XYYYY, with X between 1 and 3');
  return phone;
}

export class TelegramTestUser {
  readonly client: TelegramClient;
  readonly phone: string;
  readonly signal: AbortSignal;
  account!: User;
  readonly #controller = new AbortController();
  #closing?: Promise<void>;

  private constructor(credentials: TelegramTestCredentials, signal?: AbortSignal) {
    this.phone = testPhone(credentials.phone ?? `999662${randomInt(10000).toString().padStart(4, '0')}`);
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    this.client = new TelegramClient({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      storage: new MemoryStorage(),
      testMode: true,
    });
  }

  static async login(credentials: TelegramTestCredentials, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TelegramTestUser> {
    const user = new TelegramTestUser(credentials, options.signal);
    const signal = AbortSignal.any([user.signal, AbortSignal.timeout(options.timeoutMs ?? 60000)]);
    const closeOnAbort = () => { void user.close().catch(error => user.client.onError.emit(error)); };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      signal.throwIfAborted();
      const config = await user.call({ _: 'help.getConfig' }, signal);
      if (!config.testMode) throw new Error('Refusing to authorize a test account outside the Telegram test network');
      const sent = await user.call({
        _: 'auth.sendCode', phoneNumber: user.phone,
        apiId: credentials.apiId, apiHash: credentials.apiHash, settings: { _: 'codeSettings' },
      }, signal);
      let authorization: tl.auth.TypeAuthorization;
      if (sent._ === 'auth.sentCodeSuccess') {
        authorization = sent.authorization;
      } else if (sent._ === 'auth.sentCode') {
        authorization = await user.call({
          _: 'auth.signIn', phoneNumber: user.phone, phoneCodeHash: sent.phoneCodeHash,
          phoneCode: user.phone[5]!.repeat(5),
        }, signal);
      } else {
        throw new Error(`Unexpected test-account authorization response: ${sent._}`);
      }
      if (authorization._ === 'auth.authorizationSignUpRequired') {
        authorization = await user.call({
          _: 'auth.signUp', phoneNumber: user.phone,
          phoneCodeHash: sent._ === 'auth.sentCode' ? sent.phoneCodeHash : '',
          firstName: 'OMP test', lastName: '',
        }, signal);
      }
      if (authorization._ !== 'auth.authorization') throw new Error(`Unexpected test-account authorization response: ${authorization._}`);
      await user.client.notifyLoggedIn(authorization);
      user.account = await user.client.getMe();
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
