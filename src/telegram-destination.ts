import type { Api, Context } from 'grammy';
import { topicDestination, type TopicDestination } from '../shared/topic-destination.js';

type MessageExtra = Omit<NonNullable<Parameters<Api['sendMessage']>[2]>, 'message_thread_id' | 'chat_id'>;
type ForwardExtra = Omit<NonNullable<Parameters<Api['forwardMessage']>[3]>, 'message_thread_id' | 'chat_id'>;

export function contextDestination(ctx: Context): TopicDestination {
  const message = ctx.message ?? (ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined);
  if (!ctx.chat) throw new TypeError('Telegram destination requires a chat');
  return topicDestination(ctx.chat.id, message && 'message_thread_id' in message ? message.message_thread_id : undefined);
}

export function replyTo(ctx: Context, destination: TopicDestination, text: string, extra?: MessageExtra) {
  return sendTo(ctx.api, destination, text, extra);
}

export function sendTo(api: Api, destination: TopicDestination, text: string, extra?: MessageExtra, signal?: Parameters<Api['sendMessage']>[3]) {
  return api.sendMessage(destination.chatId, text, { ...extra, message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined }, signal);
}

export function forwardTo(api: Api, destination: TopicDestination, fromChatId: Parameters<Api['forwardMessage']>[1], messageId: number, extra?: ForwardExtra) {
  return api.forwardMessage(destination.chatId, fromChatId, messageId, { ...extra, message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined });
}
