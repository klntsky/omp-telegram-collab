export type TopicDestination =
  | { kind: 'general'; chatId: number }
  | { kind: 'topic'; chatId: number; threadId: number };

export function topicDestination(chatId: number, threadId?: number): TopicDestination {
  return threadId === undefined || threadId === 1
    ? { kind: 'general', chatId }
    : { kind: 'topic', chatId, threadId };
}

export function sameTopicDestination(left: TopicDestination, right: TopicDestination): boolean {
  return left.chatId === right.chatId && left.kind === right.kind &&
    (left.kind === 'general' || (right.kind === 'topic' && left.threadId === right.threadId));
}
