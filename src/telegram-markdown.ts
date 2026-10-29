import { Lexer, type Tokens } from '../web/src/vendor/marked/core.js';

/** Keep Markdown blocks together within Telegram's rich-message text limit. */
export function renderTelegramMarkdown(source: string): string[] {
  const limit = 32768;
  if (Array.from(source).length <= limit) return source ? [source] : [];
  const chunks: string[] = [];
  let chunk = '';
  let length = 0;
  const lexer = new Lexer({ gfm: true });
  for (const token of lexer.blockTokens(source)) {
    const characters = Array.from(token.raw);
    if (length + characters.length > limit && chunk) {
      chunks.push(chunk);
      chunk = '';
      length = 0;
    }
    if (characters.length <= limit) {
      chunk += token.raw;
      length += characters.length;
      continue;
    }
    if (token.type === 'code') {
      const block = token as Tokens.Code;
      const fence = '`'.repeat(Math.max(3, ...Array.from(block.text.matchAll(/`+/g), match => match[0].length + 1)));
      const opening = `${fence}${block.lang ?? ''}\n`;
      const capacity = limit - Array.from(opening).length - fence.length - 1;
      const body = Array.from(block.text);
      for (let start = 0; start < body.length; start += capacity) {
        chunks.push(`${opening}${body.slice(start, start + capacity).join('')}\n${fence}`);
      }
    } else {
      for (let start = 0; start < characters.length; start += limit) {
        chunks.push(characters.slice(start, start + limit).join(''));
      }
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
