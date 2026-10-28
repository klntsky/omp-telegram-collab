import type { Context, Telegram } from 'telegraf';
import { FmtString } from 'telegraf/format';
import { topicDestination, type TopicDestination } from '../shared/topic-destination.js';

type MessageExtra = Omit<NonNullable<Parameters<Telegram['sendMessage']>[2]>, 'message_thread_id' | 'chat_id'>;
type ForwardExtra = Omit<NonNullable<Parameters<Telegram['forwardMessage']>[3]>, 'message_thread_id' | 'chat_id'>;

export function contextDestination(ctx: Context): TopicDestination {
  const message = ctx.message ?? (ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined);
  if (!ctx.chat) throw new TypeError(`Telegraf: "sendMessage" isn't available for "${ctx.updateType}"`);
  return topicDestination(ctx.chat.id, message && 'message_thread_id' in message ? message.message_thread_id : undefined);
}

export function replyTo(ctx: Context, destination: TopicDestination, text: Parameters<Context['reply']>[0], extra?: MessageExtra) {
  return sendTo(ctx.telegram, destination, text, extra);
}

export function sendTo(telegram: Telegram, destination: TopicDestination, text: Parameters<Telegram['sendMessage']>[1], extra?: MessageExtra, options?: Parameters<Telegram['callApi']>[2]) {
  const parameters = { ...extra, message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined };
  return options === undefined
    ? telegram.sendMessage(destination.chatId, text, parameters)
    : telegram.callApi('sendMessage', { chat_id: destination.chatId, ...parameters, ...FmtString.normalise(text) }, options);
}

export function sendVia<T>(call: (payload: Record<string, unknown>) => Promise<T>, destination: TopicDestination, text: Parameters<Telegram['sendMessage']>[1], extra?: MessageExtra): Promise<T> {
  return call({ ...extra, chat_id: destination.chatId, ...FmtString.normalise(text), message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined });
}

export function forwardTo(telegram: Telegram, destination: TopicDestination, fromChatId: Parameters<Telegram['forwardMessage']>[1], messageId: number, extra?: ForwardExtra) {
  return telegram.forwardMessage(destination.chatId, fromChatId, messageId, { ...extra, message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined });
}
