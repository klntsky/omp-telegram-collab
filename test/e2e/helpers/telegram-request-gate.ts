import type { Bot } from 'grammy';

export function holdTelegramRequest(bot: Bot, matches: (method: string, payload: unknown) => boolean, lifetime: AbortSignal) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let held = false;
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (!held && matches(method, payload)) {
      held = true;
      const cancelled = Promise.withResolvers<never>();
      const abort = () => cancelled.reject(new Error('Telegram request gate cancelled'));
      if (signal?.aborted || lifetime.aborted) abort();
      else {
        signal?.addEventListener('abort', abort, { once: true });
        lifetime.addEventListener('abort', abort, { once: true });
      }
      entered.resolve();
      try { await Promise.race([released.promise, cancelled.promise]); }
      finally {
        signal?.removeEventListener('abort', abort);
        lifetime.removeEventListener('abort', abort);
      }
    }
    return previous(method, payload, signal);
  });
  return { entered: entered.promise, release: released.resolve };
}
