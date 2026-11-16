import type { Bot } from 'grammy';

export function holdTelegramAcknowledgement(bot: Bot, pending: () => boolean) {
  let held = false;
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === 'getUpdates' && pending() && 'offset' in payload && Number(payload.offset) > 0) {
      held = true;
      if (!signal) throw new Error('Telegram acknowledgement gate requires cancellation');
      const cancelled = new Error('Telegram acknowledgement gate cancelled');
      const cancellation = Promise.withResolvers<never>();
      if (signal.aborted) cancellation.reject(cancelled);
      else signal.addEventListener('abort', () => cancellation.reject(cancelled), { once: true });
      await cancellation.promise;
    }
    return previous(method, payload, signal);
  });
  return () => held;
}
