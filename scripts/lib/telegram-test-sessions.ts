import { createHash, randomUUID } from 'node:crypto';
import { TelegramClient, tl } from '@mtcute/node';
import { readStringSession, writeStringSession } from '@mtcute/node/utils.js';
import { createTelegramTestBaseClient, exportTelegramTestSession, readTelegramApplicationCredentials } from './telegram-test-auth.js';
import { acquireTelegramTestLock, withTelegramTestLock } from './telegram-test-lock.js';
import { resolveTelegramTestEnvFile, withTelegramTestSessionStorage } from '../../test/e2e/helpers/telegram-env.js';
import { combineTelegramErrors } from '../../test/e2e/helpers/errors.js';

export interface TelegramTestSession {
  client: TelegramClient;
  close(): Promise<void>;
}

export function telegramTestSessionLockName(session: string): string {
  return `auth-key:${createHash('sha256').update(readStringSession(session).authKey).digest('hex')}`;
}

export function isDeadTelegramTestSession(error: unknown): boolean {
  return tl.RpcError.is(error, 'AUTH_KEY_UNREGISTERED')
    || tl.RpcError.is(error, 'SESSION_REVOKED')
    || tl.RpcError.is(error, 'SESSION_EXPIRED')
    || tl.RpcError.is(error, 'USER_DEACTIVATED')
    || tl.RpcError.is(error, 'AUTH_KEY_DUPLICATED')
    || tl.RpcError.is(error, 'USER_DEACTIVATED_BAN');
}

export async function forkTelegramTestSession(signal: AbortSignal): Promise<TelegramTestSession> {
  let prepared: TelegramTestSession | undefined;
  try {
    return await withTelegramTestLock('authorization', signal, async () => withTelegramTestSessionStorage(await resolveTelegramTestEnvFile(), async storage => {
    const credentials = readTelegramApplicationCredentials(storage.env);
    const failures: unknown[] = [];
    let busy = 0;
    for (const session of [...storage.sessions]) {
      signal.throwIfAborted();
      const releaseSeed = await acquireTelegramTestLock(telegramTestSessionLockName(session), signal, true);
      if (!releaseSeed) { busy++; continue; }
      const seed = createTelegramTestBaseClient(credentials);
      let originalFailure: unknown;
      let usable = false;
      try {
        await seed.importSession(session);
        await seed.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }, { abortSignal: signal, timeout: 30000 });
        usable = true;
        const base = createTelegramTestBaseClient(credentials, readStringSession(session).primaryDcs);
        const client = new TelegramClient({ client: base, skipConversationUpdates: false });
        const childLeases = new Map<string, () => Promise<void>>();
        let approved = false;
        const persist = async () => {
          const data = readStringSession(await client.exportSession());
          const retained = writeStringSession({ ...data, primaryDcs: {
            main: { ...data.primaryDcs.main, testMode: true },
            media: { ...data.primaryDcs.media, testMode: true },
          } });
          const lockName = telegramTestSessionLockName(retained);
          if (!childLeases.has(lockName)) {
            const release = await acquireTelegramTestLock(lockName, new AbortController().signal, true);
            if (!release) throw new Error('Fresh Telegram session auth key is already leased');
            childLeases.set(lockName, release);
          }
          const existing = storage.sessions.findIndex(value => telegramTestSessionLockName(value) === lockName);
          const next = [...storage.sessions];
          if (existing === -1) next.push(retained); else next[existing] = retained;
          await storage.save(next);
          storage.sessions.splice(0, storage.sessions.length, ...next);
        };
        try {
          const token = await base.call({ _: 'auth.exportLoginToken', apiId: credentials.apiId, apiHash: credentials.apiHash, exceptIds: [] }, { abortSignal: signal, timeout: 30000 });
          if (token._ !== 'auth.loginToken') throw new Error(`Unexpected fresh Telegram QR response: ${token._}`);
          approved = true;
          try {
            await seed.call({ _: 'auth.acceptLoginToken', token: token.token }, { abortSignal: signal, timeout: 30000 });
          } catch (error) {
            if (isDeadTelegramTestSession(error)) usable = false;
            throw error;
          }
          await persist();
          let result = await base.call({ _: 'auth.exportLoginToken', apiId: credentials.apiId, apiHash: credentials.apiHash, exceptIds: [] }, { abortSignal: signal, timeout: 30000 });
          if (result._ === 'auth.loginTokenMigrateTo') {
            await base.changePrimaryDc(result.dcId);
            const migrated = await base.call({ _: 'auth.importLoginToken', token: result.token }, { abortSignal: signal, timeout: 30000 });
            result = migrated;
            await persist();
          }
          if (result._ !== 'auth.loginTokenSuccess') throw new Error(`Telegram QR authorization did not complete: ${result._}`);
          if (result.authorization._ !== 'auth.authorization') throw new Error('Telegram QR authorization requires signup');
          await base.notifyLoggedIn(result.authorization);
          await persist();
          await exportTelegramTestSession(client, signal);
          let closing: Promise<void> | undefined;
          return prepared = { client, close() {
            return closing ??= (async () => {
              const errors: unknown[] = [];
              try { await client.destroy(); } catch (error) { errors.push(error); }
              for (const release of childLeases.values()) {
                try { await release(); } catch (error) { errors.push(error); }
              }
              if (errors.length === 1) throw errors[0];
              if (errors.length > 1) throw combineTelegramErrors(...errors);
            })();
          } };
        } catch (error) {
          const errors = [error];
          if (approved) { try { await persist(); } catch (retentionError) { errors.push(retentionError); } }
          try { await client.destroy(); } catch (cleanup) { errors.push(cleanup); }
          for (const release of childLeases.values()) { try { await release(); } catch (cleanup) { errors.push(cleanup); } }
          throw errors.length === 1 ? error : combineTelegramErrors(...errors);
        }
      } catch (error) {
        originalFailure = error;
        failures.push(error);
        if (!usable && isDeadTelegramTestSession(error)) {
          storage.sessions.splice(storage.sessions.indexOf(session), 1);
          await storage.save(storage.sessions);
        } else {
          throw error;
        }
      } finally {
        const cleanupErrors: unknown[] = [];
        try { await seed.destroy(); } catch (error) { cleanupErrors.push(error); }
        try { await releaseSeed(); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) throw combineTelegramErrors(...(originalFailure === undefined ? cleanupErrors : [originalFailure, ...cleanupErrors]));
      }
    }
    const context = `No available Telegram test seed session (${busy} active; ${failures.length} failed). Run pnpm telegram:test:login if none remain.`;
    throw new AggregateError(failures, [context, ...failures.map(error => error instanceof Error ? error.message : String(error))].join('\n'), { cause: failures[0] });
    }, true));
  } catch (error) {
    if (prepared) {
      try { await prepared.close(); } catch (cleanup) { throw combineTelegramErrors(error, cleanup); }
    }
    throw error;
  }
}

export class TelegramTestExecution {
  readonly #lock = `test-execution:${randomUUID()}`;
  readonly #controller = new AbortController();
  #session?: Promise<TelegramTestSession>;
  #closing?: Promise<void>;

  constructor(private readonly createSession = forkTelegramTestSession) {}

  async acquire(signal: AbortSignal): Promise<TelegramTestSession> {
    const scope = AbortSignal.any([signal, this.#controller.signal]);
    scope.throwIfAborted();
    const release = (await acquireTelegramTestLock(this.#lock, scope))!;
    try {
      scope.throwIfAborted();
      const session = await (this.#session ??= this.createSession(scope));
      scope.throwIfAborted();
      return { client: session.client, close: release };
    } catch (error) {
      try { await release(); } catch (cleanup) { throw combineTelegramErrors(error, cleanup); }
      throw error;
    }
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#controller.abort(new Error('Telegram test execution closed'));
      await (await this.#session)?.close();
    })();
  }
}
