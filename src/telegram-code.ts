import type { Api } from 'grammy';

type MessageEntity = NonNullable<NonNullable<Parameters<Api['sendMessage']>[2]>['entities']>[number];

export function codeEntities(text: string, values: readonly string[]): MessageEntity[] {
  const entities: MessageEntity[] = [];
  const candidates = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of candidates) {
    let offset = text.indexOf(value);
    while (offset !== -1) {
      if (!entities.some(entity => offset < entity.offset + entity.length && entity.offset < offset + value.length))
        entities.push({ type: 'code', offset, length: value.length });
      offset = text.indexOf(value, offset + value.length);
    }
  }
  // Telegram entity offsets use UTF-16, matching JavaScript string indices.
  // https://core.telegram.org/bots/api/types/messageentity.md
  return entities.sort((a, b) => a.offset - b.offset);
}
