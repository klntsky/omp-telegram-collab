import { BaseTelegramClient, MemoryStorage, TelegramClient } from '@mtcute/node';
import { readStringSession, writeStringSession } from '@mtcute/node/utils.js';

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

export async function exportTelegramTestSession(client: TelegramClient, signal: AbortSignal): Promise<string> {
  const config = await client.call({ _: 'help.getConfig' }, { timeout: 30000, abortSignal: signal });
  if (!config.testMode) throw new Error('Refusing to export a Telegram session outside the test network');
  const data = readStringSession(await client.exportSession());
  for (const dc of [data.primaryDcs.main, data.primaryDcs.media]) {
    if (!config.dcOptions.some(option => option.id === dc.id && option.ipAddress === dc.ipAddress && option.port === dc.port)) {
      throw new Error('Exported Telegram session contains a datacenter outside the verified test-network configuration');
    }
  }
  return writeStringSession({
    ...data,
    primaryDcs: {
      main: { ...data.primaryDcs.main, testMode: true },
      media: { ...data.primaryDcs.media, testMode: true },
    },
  });
}

export function readTelegramTestSessions(env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env.TELEGRAM_TEST_SESSIONS;
  if (!value) throw new Error('Run pnpm telegram:test:login to save TELEGRAM_TEST_SESSIONS in .env before running live tests');
  let sessions: unknown;
  try { sessions = JSON.parse(value); } catch {
    throw new Error('TELEGRAM_TEST_SESSIONS must be a JSON array of unique nonempty Telegram test user sessions');
  }
  if (!Array.isArray(sessions) || sessions.length === 0
    || sessions.some(session => typeof session !== 'string' || session.trim().length === 0)
    || new Set(sessions).size !== sessions.length) {
    throw new Error('TELEGRAM_TEST_SESSIONS must be a JSON array of unique nonempty Telegram test user sessions');
  }
  for (const session of sessions) validateTelegramTestSession(session);
  return sessions;
}

export function readTelegramTestCredentials(env: NodeJS.ProcessEnv = process.env): TelegramTestCredentials {
  const application = readTelegramApplicationCredentials(env);
  const [session] = readTelegramTestSessions(env);
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

export function createTelegramTestBaseClient(credentials: TelegramApplicationCredentials, defaultDcs?: ReturnType<typeof readStringSession>['primaryDcs']): BaseTelegramClient {
  return new BaseTelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage: new MemoryStorage(),
    testMode: true,
    defaultDcs,
    network: { middlewares: [] },
  });
}
