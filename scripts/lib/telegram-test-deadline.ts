export const telegramTestTimeouts = {
  lease: 10_000,
  request: 30_000,
  authorization: 45_000,
  provision: 90_000,
  readiness: 60_000,
  expectation: 30_000,
  cleanup: 15_000,
} as const;

const expirations = new WeakMap<AbortSignal, number>();

export function telegramTestDeadlineRemaining(signal: AbortSignal): number {
  return Math.max(0, (expirations.get(signal) ?? Infinity) - performance.now());
}

export async function withTelegramTestDeadline<T>(
  name: string,
  timeoutMs: number,
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  expirations.set(controller.signal, performance.now() + Math.min(timeoutMs, telegramTestDeadlineRemaining(parent)));
  const cancelled = Promise.withResolvers<never>();
  const abort = (reason: unknown) => {
    cancelled.reject(reason);
    controller.abort(reason);
  };
  const onAbort = () => abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  const timeoutError = new Error(`Telegram test ${name} timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => abort(timeoutError), Math.min(timeoutMs, telegramTestDeadlineRemaining(parent)));
  const operation = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return run(controller.signal);
  });
  void operation.catch(error => {
    if (controller.signal.aborted && error !== controller.signal.reason)
      console.error(`Telegram test ${name} failed after cancellation.`, error);
  });
  try {
    return await Promise.race([operation, cancelled.promise]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}
