import { GrammyError, HttpError, type Bot } from 'grammy';

export class TelegramTopicNotModifiedError extends Error {}
export class TelegramMessageNotModifiedError extends Error {}
export class TelegramMessageMissingError extends Error {}
export class TelegramTopicMissingError extends Error {}
export class TelegramDeliveryTimeoutError extends Error {}
export class TelegramRequestCancelledError extends Error {}
export class TelegramFileDownloadError extends Error {}
export class TelegramAccessDeniedError extends Error {}

const accessRejections: Record<string, true> = {
  'Bad Request: chat not found': true,
  'Bad Request: private chat not found': true,
  'Bad Request: user not found': true,
  'Bad Request: group chat was upgraded to a supergroup chat': true,
  'Forbidden: user is deactivated': true,
  'Forbidden: the group chat was deleted': true,
  'Forbidden: bot was kicked from the group chat': true,
  'Forbidden: bot is not a member of the group chat': true,
  'Forbidden: bot was kicked from the supergroup chat': true,
  'Forbidden: bot was kicked from the channel chat': true,
  'Forbidden: bot is not a member of the supergroup chat': true,
  'Forbidden: bot is not a member of the channel chat': true,
};

export function redactTelegramFailure(error: unknown, token: string): void {
  const secrets = [token, encodeURIComponent(token)].filter(Boolean);
  const redact = (text: string) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[redacted bot token]'), text);
  const seen = new Set<Error>();
  const visit = (failure: unknown): void => {
    if (!(failure instanceof Error) || seen.has(failure)) return;
    seen.add(failure);
    // Unlike ordinary diagnostics, credentials must not survive in inspectable causes or
    // cached stacks. Mutate only secret-bearing strings while retaining every error identity.
    const stack = failure.stack;
    const message = redact(failure.message);
    // Native fetch cancellation uses DOMException.message, an inherited getter.
    // Shadow it only when redaction is necessary so cancellation keeps its identity.
    // https://github.com/nodejs/node/blob/v26.13.0/lib/internal/per_context/domexception.js (DOMException.message).
    if (message !== failure.message)
      Object.defineProperty(failure, 'message', {value: message, writable: true, configurable: true});
    if (stack !== undefined) {
      const safeStack = redact(stack);
      if (safeStack !== stack) failure.stack = safeStack;
    }
    if (typeof failure.cause === 'string') failure.cause = redact(failure.cause);
    else visit(failure.cause);
    if (failure instanceof HttpError) {
      if (typeof failure.error === 'string')
        Object.defineProperty(failure, 'error', {value: redact(failure.error), writable: true, configurable: true, enumerable: true});
      else visit(failure.error);
    }
    if (failure instanceof AggregateError) {
      for (let index = 0; index < failure.errors.length; index++) {
        if (typeof failure.errors[index] === 'string') failure.errors[index] = redact(failure.errors[index]);
        else visit(failure.errors[index]);
      }
    }
  };
  visit(error);
}

export function installTelegramErrors(bot: Bot, token: string): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    const identifiers = ['chat_id', 'message_thread_id', 'message_id', 'user_id'].flatMap(key => {
      const value = Reflect.get(payload, key);
      return typeof value === 'number' || typeof value === 'string' ? [`${key}=${value}`] : [];
    });
    const context = `Telegram ${method}${identifiers.length ? ` (${identifiers.join(', ')})` : ''}`;
    let response;
    try {
      response = await previous(method, payload, signal);
    } catch (error) {
      // Preserve dependency identity and fields; never copy payloads or token-bearing URLs into diagnostics.
      redactTelegramFailure(error, token);
      // grammY toHttpError omits the native diagnostic unless sensitiveLogs is enabled.
      // Retain it without enabling token-bearing logging or replacing the HttpError.
      // https://github.com/grammyjs/grammY/blob/main/src/core/error.ts — toHttpError.
      if (error instanceof HttpError)
        error.message = `${error.message}\n${error.error instanceof Error ? error.error.message : String(error.error)}`;
      if (signal?.aborted && error instanceof HttpError)
        throw new TelegramRequestCancelledError(`${context}: ${error.message}`, {cause: error});
      if (error instanceof Error) error.message = `${context}: ${error.message}`;
      throw error;
    }
    if (response.ok) return response;
    // Match grammY's exact diagnostic before adding our resource context.
    // https://github.com/grammyjs/grammY/blob/main/src/core/error.ts — toGrammyError.
    const original = new GrammyError(`Call to '${method}' failed!`, response, method, payload);
    const message = `${context}: ${original.message}`;
    // Client::check_chat_access, TdOnCheckChatCallback, and TdOnCheckUserCallback
    // produce these explicit inaccessible-resource rejections for membership reads.
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
    // Other 4xx responses (especially token/configuration failures) remain operational failures.
    if ((method === 'getChat' || method === 'getChatMember') &&
        (response.error_code === 400 || response.error_code === 403) && Object.hasOwn(accessRejections, response.description))
      throw new TelegramAccessDeniedError(message, {cause: original});
    // Telegram keeps these RPC diagnostics for bots instead of silently accepting a no-op.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp — EditForumTopicQuery::on_error.
    if (method === 'editForumTopic' && response.error_code === 400 && response.description === 'Bad Request: TOPIC_NOT_MODIFIED')
      throw new TelegramTopicNotModifiedError(message, {cause: original});
    // Client::fail_query_with_error expands MESSAGE_NOT_MODIFIED; check_message uses the missing-message diagnostic.
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
    if (method === 'editMessageReplyMarkup' && response.error_code === 400) {
      if (response.description.startsWith('Bad Request: message is not modified:'))
        throw new TelegramMessageNotModifiedError(message, {cause: original});
      if (response.description === 'Bad Request: message to edit not found')
        throw new TelegramMessageMissingError(message, {cause: original});
    }
    // check_message_topic/getForumTopic reject a missing thread before sending, so only that
    // explicit rejection is safe to recover by creating a replacement status topic.
    if (method === 'sendMessage' && response.error_code === 400 &&
        response.description === 'Bad Request: message thread not found')
      throw new TelegramTopicMissingError(message, {cause: original});
    original.message = message;
    throw original;
  });
}
