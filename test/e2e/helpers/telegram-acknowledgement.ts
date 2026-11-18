import type { Bot } from 'grammy';

// Hold the next offset request, not a fabricated response: Telegram confirms earlier updates at that boundary.
// Bot API Client::do_get_updates passes the requested offset to TQueue::get; offset zero resumes at its head.
// https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L18253-L18291
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
