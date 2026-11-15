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
