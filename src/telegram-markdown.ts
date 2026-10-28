import { Lexer, type Token, type Tokens } from '../web/src/vendor/marked/core.js';

type Tag = { name: string; open: string };
type Run = { text: string; tags: readonly Tag[] };
const bold: Tag = { name: 'b', open: '<b>' };
const italic: Tag = { name: 'i', open: '<i>' };
const strike: Tag = { name: 's', open: '<s>' };
const quote: Tag = { name: 'blockquote', open: '<blockquote>' };
const code: Tag = { name: 'code', open: '<code>' };
const pre: Tag = { name: 'pre', open: '<pre>' };

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeLink(href: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(href)) return undefined;
  try {
    const url = new URL(href);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch { /* Relative and malformed links remain readable text. */ }
  return undefined;
}

function withTag(tags: readonly Tag[], tag: Tag): readonly Tag[] {
  return tags.some(active => active.name === tag.name) ? tags : [...tags, tag];
}

class MarkdownRuns {
  readonly runs: Run[] = [];

  text(text: string, tags: readonly Tag[]): void {
    if (text) this.runs.push({ text, tags });
  }

  inline(tokens: Token[], tags: readonly Tag[]): void {
    for (const token of tokens) {
      switch (token.type) {
        case 'strong':
          this.inline((token as Tokens.Strong).tokens, withTag(tags, bold));
          break;
        case 'em':
          this.inline((token as Tokens.Em).tokens, withTag(tags, italic));
          break;
        case 'del':
          this.inline((token as Tokens.Del).tokens, withTag(tags, strike));
          break;
        case 'codespan':
          // Telegram does not allow other formatting entities inside code entities.
          this.text((token as Tokens.Codespan).text, [code]);
          break;
        case 'link': {
          const link = token as Tokens.Link;
          const href = safeLink(link.href);
          const linkTags = href && !tags.some(tag => tag.name === 'a')
            ? [...tags, { name: 'a', open: `<a href="${escapeHtml(href)}">` }]
            : tags;
          this.inline(link.tokens, linkTags);
          break;
        }
        case 'image': {
          const image = token as Tokens.Image;
          this.text(image.text || 'Image', tags);
          this.text(` (${image.href})`, tags);
          break;
        }
        case 'br':
          this.text('\n', tags);
          break;
        case 'html':
          this.text((token as Tokens.HTML).text, tags);
          break;
        default:
          if ('tokens' in token && token.tokens) this.inline(token.tokens, tags);
          else this.text('text' in token && typeof token.text === 'string' ? token.text : token.raw, tags);
      }
    }
  }

  blocks(tokens: Token[], tags: readonly Tag[] = [], depth = 0, separator = '\n\n'): void {
    let first = true;
    for (const token of tokens) {
      if (token.type === 'space' || token.type === 'def' || token.type === 'checkbox') continue;
      if (!first) this.text(separator, tags);
      first = false;
      switch (token.type) {
        case 'heading':
          this.inline((token as Tokens.Heading).tokens, withTag(tags, bold));
          break;
        case 'paragraph':
        case 'text':
          if (token.tokens) this.inline(token.tokens, tags);
          else this.text(token.text, tags);
          break;
        case 'code': {
          const block = token as Tokens.Code;
          const language = block.lang?.split(/\s/)[0];
          const codeTag = language && /^[a-zA-Z0-9_+-]+$/.test(language)
            ? { name: 'code', open: `<code class="language-${language}">` }
            : code;
          const body = block.raw.slice(block.raw.indexOf('\n') + 1);
          const literal = !block.codeBlockStyle && body.startsWith(`${block.text}\n`) ? `${block.text}\n` : block.text;
          this.text(literal, [pre, codeTag]);
          break;
        }
        case 'blockquote':
          this.blocks((token as Tokens.Blockquote).tokens, withTag(tags, quote), depth);
          break;
        case 'list': {
          const list = token as Tokens.List;
          list.items.forEach((item, index) => {
            if (index) this.text('\n', tags);
            const marker = list.ordered ? `${Number(list.start) + index}.` : '•';
            this.text(`${'  '.repeat(depth)}${marker} ${item.task ? (item.checked ? '☑ ' : '☐ ') : ''}`, tags);
            this.blocks(item.tokens, tags, depth + 1, '\n');
          });
          break;
        }
        case 'table': {
          const table = token as Tokens.Table;
          [table.header, ...table.rows].forEach((row, index) => {
            if (index) this.text('\n', tags);
            row.forEach((cell, column) => {
              if (column) this.text(' | ', tags);
              this.inline(cell.tokens, index === 0 ? withTag(tags, bold) : tags);
            });
          });
          break;
        }
        case 'hr':
          this.text('———', tags);
          break;
        default:
          this.inline([token], tags);
      }
    }
  }
}

function splitRuns(runs: Run[], limit: number): string[] {
  const chunks: string[] = [];
  let html = '';
  let length = 0;
  let active: readonly Tag[] = [];
  const transition = (tags: readonly Tag[]) => {
    let shared = 0;
    while (shared < active.length && shared < tags.length && active[shared]!.open === tags[shared]!.open) shared++;
    for (let i = active.length - 1; i >= shared; i--) html += `</${active[i]!.name}>`;
    for (let i = shared; i < tags.length; i++) html += tags[i]!.open;
    active = tags;
  };
  const flush = () => {
    if (!length) return;
    transition([]);
    chunks.push(html);
    html = '';
    length = 0;
  };
  for (const run of runs) {
    let start = 0;
    while (start < run.text.length) {
      let end = Math.min(run.text.length, start + limit - length);
      if (end < run.text.length && /[\uD800-\uDBFF]/.test(run.text[end - 1]!)) end--;
      if (end === start) {
        flush();
        continue;
      }
      transition(run.tags);
      html += escapeHtml(run.text.slice(start, end));
      length += end - start;
      start = end;
      if (length === limit) flush();
    }
  }
  flush();
  return chunks;
}

/** Telegram counts the decoded text, not HTML markup, toward its 4096-character limit. */
export function renderTelegramMarkdown(source: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new RangeError('Telegram chunk limit must be between 2 and 4096');
  // The convenience lexer expands tabs and normalizes CRLF, including inside code.
  // The public block/inline stages retain the original literal characters.
  const lexer = new Lexer({ gfm: true });
  lexer.blockTokens(source);
  for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
  const rendered = new MarkdownRuns();
  rendered.blocks(lexer.tokens);
  return splitRuns(rendered.runs, limit);
}
