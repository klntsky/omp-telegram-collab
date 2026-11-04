import { BaseTelegramClient, MemoryStorage, type RpcCallMiddleware } from '@mtcute/node';
import type { TelegramApplicationCredentials } from './telegram-test-auth.js';

export function createCentralTelegramTestClient(credentials: TelegramApplicationCredentials, networkBoundary?: RpcCallMiddleware): BaseTelegramClient {
  return new BaseTelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage: new MemoryStorage(),
    testMode: true,
    network: { middlewares: networkBoundary ? [networkBoundary] : [] },
  });
}
