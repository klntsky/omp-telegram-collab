export function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  operation.then(resolve, reject);
  if (signal.aborted) abort();
  return promise.finally(() => signal.removeEventListener('abort', abort));
}
