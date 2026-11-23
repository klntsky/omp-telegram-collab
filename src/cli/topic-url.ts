import { InvalidArgumentError } from 'commander';

export function parseTopicUrl(topicUrl: string): { chat: number; topic: number } {
  const url = new URL(topicUrl.includes('://') ? topicUrl : `https://${topicUrl}`);
  const match = /^\/c\/([1-9]\d*)\/([1-9]\d*)(?:\/([1-9]\d*))?\/?$/.exec(url.pathname);
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 't.me' || url.port || url.username || url.password || !match)
    throw new InvalidArgumentError('Expected a Telegram topic URL such as https://t.me/c/1234567890/42.');
  const chat = Number(`-100${match[1]}`);
  // Telegram topic IDs are creation-message IDs. Message links can instead
  // carry the topic in the path or thread query. https://core.telegram.org/api/links#message-links
  const topicValue = url.searchParams.get('thread') ?? match[2];
  const topic = Number(topicValue);
  if (!Number.isSafeInteger(chat) || !/^[1-9]\d*$/.test(topicValue) || !Number.isSafeInteger(topic) || topic <= 1)
    throw new InvalidArgumentError('Topic URL must contain a safe chat ID and a topic ID greater than one.');
  return { chat, topic };
}
