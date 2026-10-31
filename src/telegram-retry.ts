import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot } from 'grammy';
import type { AbortSignal as TelegramAbortSignal } from 'abort-controller';

const deliveryRetry = new AsyncLocalStorage<boolean>();

export function withTelegramDeliveryRetry<T>(action: () => Promise<T>): Promise<T> {
  return deliveryRetry.run(true, action);
}

function waitForRetry(seconds: number, serviceSignal: AbortSignal, requestSignal?: TelegramAbortSignal): Promise<void> {
  if (serviceSignal.aborted || requestSignal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  let timer: NodeJS.Timeout;
  let remaining = seconds;
  const done = () => {
    clearTimeout(timer);
    serviceSignal.removeEventListener('abort', done);
    requestSignal?.removeEventListener('abort', done);
    resolve();
  };
  const schedule = () => {
    const milliseconds = Math.min(remaining, 2_147_483.647) * 1000;
    remaining = Math.max(0, remaining - milliseconds / 1000);
    timer = setTimeout(remaining > 0 ? schedule : done, milliseconds);
  };
  serviceSignal.addEventListener('abort', done, { once: true });
  requestSignal?.addEventListener('abort', done, { once: true });
  schedule();
  return promise;
}

export function installTelegramRetry(bot: Bot, signal: AbortSignal): void {
  bot.api.config.use(async (previous, method, payload, requestSignal) => {
    let response = await previous(method, payload, requestSignal);
    while (!deliveryRetry.getStore() && !response.ok && response.error_code === 429) {
      const seconds = response.parameters?.retry_after;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || signal.aborted || requestSignal?.aborted) return response;
      await waitForRetry(seconds, signal, requestSignal);
      if (signal.aborted || requestSignal?.aborted) return response;
      response = await previous(method, payload, requestSignal);
    }
    return response;
  });
}
