import { setTimeout as delay } from 'node:timers/promises';

export async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([operation, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function waitUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const value = await bounded(read(), signal);
    if (ready(value)) return value;
    await delay(200, undefined, { signal });
  }
}
