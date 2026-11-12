import { GrammyError } from 'grammy';

const reported = new WeakSet<object>();

export function pollingFailureReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reported.has(error);
}

/** Own the diagnostic once, while callers continue propagating the original failure. */
export function reportPollingFailure(bot: { id: number; username?: string }, error: unknown): void {
  if (pollingFailureReported(error)) return;
  const identity = `${bot.username ? `@${bot.username} ` : ''}(bot ${bot.id})`;
  // Telegram's Client::abort_long_poll and fail_query_conflict return 409 for
  // competing getUpdates consumers. This is fatal, not a network retry:
  // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
  const context = error instanceof GrammyError && error.error_code === 409
    ? `Telegram polling conflict for ${identity}. Independent service processes cannot share the same Telegram bot token, even under different OS users, on different machines, or in different groups. Stop the conflicting consumer or use a separate bot token for each independent service. The entire service is stopping.`
    : `Telegram polling stopped for ${identity}. The entire service is stopping.`;
  console.error(context, error);
  if (typeof error === 'object' && error !== null) reported.add(error);
}
