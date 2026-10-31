import type { Context } from 'grammy';
import type { Message, RichBlock, RichText } from 'grammy/types';
import { parseTelegramCommand, type PromptExtension } from './telegram-commands.js';

export interface TelegramImage { fileId: string; mimeType: string }
export interface TelegramContent { text: string; images: TelegramImage[] }
export type InputIntent =
  | { kind: 'ignore' }
  | { kind: 'event' }
  | { kind: 'invalid'; error: Error }
  | { kind: 'command'; action: string; argument: string }
  | { kind: 'skill-selection'; text: string }
  | { kind: 'question-answer'; token: string; text: string }
  | { kind: 'ended-question' }
  | { kind: 'new-task' | 'session-prompt'; content: TelegramContent; extensions?: PromptExtension[] };

export interface InputContext {
  botId: number;
  username: string;
  allMessagesArePrompts: boolean;
  skillAliases: ReadonlyMap<string, { name: string }>;
  question?: string;
  endedQuestion: boolean;
}

function richText(text: RichText, bot?: {id:number;username:string}): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(part => richText(part,bot)).join('');
  if (bot && ((text.type === 'mention' && text.username.toLowerCase() === bot.username.toLowerCase()) ||
      (text.type === 'text_mention' && text.user.id === bot.id))) return '';
  if ('text' in text) {
    const label = richText(text.text,bot);
    return text.type === 'url' && label !== text.url ? `${label} (${text.url})` : label;
  }
  if (text.type === 'custom_emoji') return text.alternative_text;
  if (text.type === 'mathematical_expression') return text.expression;
  if (text.type === 'button') return richText(text.button.text,bot);
  return '';
}

function richBlocks(blocks: RichBlock[], images: TelegramImage[], bot?: {id:number;username:string}): string {
  return blocks.map(block => {
    const parts: string[] = [];
    if (block.type === 'blockquote' || block.type === 'expandable_blockquote' || block.type === 'pullquote') {
      const content = block.type === 'blockquote' ? richBlocks(block.blocks,images,bot) : richText(block.text,bot);
      const quote = [content,block.credit === undefined ? '' : richText(block.credit,bot)].filter(Boolean).join('\n\n');
      return quote ? quote.split('\n').map(line => `> ${line}`).join('\n') : '';
    }
    if (block.type === 'list') {
      return block.items.map(item => {
        const label = item.has_checkbox ? `${item.label} [${item.is_checked ? 'x' : ' '}]` : item.label;
        return `${label} ${richBlocks(item.blocks,images,bot).replace(/\n/g,'\n  ')}`;
      }).join('\n');
    }
    if (block.type === 'table') {
      parts.push(block.cells.map(row => row.map(cell => cell.text === undefined ? '' : richText(cell.text,bot)).join('\t')).join('\n'));
    }
    if (block.type === 'details') parts.push(richText(block.summary,bot));
    if ('text' in block) parts.push(richText(block.text,bot));
    if ('expression' in block) parts.push(block.expression);
    if ('blocks' in block) parts.push(richBlocks(block.blocks,images,bot));
    if (block.type === 'photo' && block.photo.length) {
      const photo = block.photo.reduce((largest,size) => size.width * size.height > largest.width * largest.height ? size : largest);
      images.push({fileId:photo.file_id,mimeType:'image/jpeg'});
    }
    if (block.type === 'document' && block.document.mime_type?.startsWith('image/')) {
      images.push({fileId:block.document.file_id,mimeType:block.document.mime_type});
    }
    if (block.type === 'map') parts.push(`${block.location.latitude}, ${block.location.longitude}`);
    if (block.type === 'buttons') parts.push(block.buttons.map(button => richText(button.text,bot)).join(' '));
    if (block.type === 'table' && block.caption !== undefined) parts.push(richText(block.caption,bot));
    else if ('caption' in block && block.caption !== undefined && typeof block.caption === 'object' && 'text' in block.caption) {
      parts.push(richText(block.caption.text,bot));
      if ('credit' in block.caption && block.caption.credit) parts.push(richText(block.caption.credit,bot));
    }
    return parts.filter(Boolean).join('\n\n');
  }).filter(Boolean).join('\n\n');
}

function messageText(message: Message, bot?: {id:number;username:string}, images: TelegramImage[] = []): string | undefined {
  if (message.rich_message) return richBlocks(message.rich_message.blocks,images,bot);
  return 'text' in message ? message.text : 'caption' in message ? message.caption : undefined;
}

export function normalizeMessage(messages: NonNullable<Context['message']>[]): TelegramContent {
  const texts: string[] = [];
  const images: TelegramImage[] = [];
  for (const message of messages) {
    const text = messageText(message,undefined,images);
    if (text) texts.push(text);
    const photo = message.photo?.length ? message.photo.reduce((largest, size) => size.width * size.height > largest.width * largest.height ? size : largest) : undefined;
    if (photo) images.push({fileId:photo.file_id,mimeType:'image/jpeg'});
    else if (message.document?.mime_type?.startsWith('image/')) images.push({fileId:message.document.file_id,mimeType:message.document.mime_type});
  }
  return {text:texts.join('\n\n'),images};
}

export function classifyMessage(message: NonNullable<Context['message']>, content: TelegramContent, context: InputContext): InputIntent {
  const lifecycle = 'forum_topic_created' in message || 'forum_topic_edited' in message || 'forum_topic_closed' in message || 'forum_topic_reopened' in message;
  if ('forward_origin' in message || 'forward_date' in message || (message.from?.is_bot && !lifecycle)) return {kind:'ignore'};
  if (lifecycle) return {kind:'event'};
  if (!message.from || message.from.is_bot) return {kind:'ignore'};
  const reply = message.reply_to_message;
  const quote = () => {
    const quoted = reply && messageText(reply);
    return quoted ? quoted.split(/\r?\n/).map(line => `> ${line}`).join('\n') : '';
  };
  const withContext = (text: string): TelegramContent => {
    const quoted = quote();
    return {...content,text:quoted ? text ? `${quoted}\n\n${text}` : quoted : text};
  };
  if (content.text.startsWith('/')) {
    const parsed = parseTelegramCommand(content.text, context.username, context.skillAliases);
    if (parsed.kind === 'ignore') return parsed;
    if (parsed.kind === 'invalid') return parsed;
    if (parsed.kind === 'selection') {
      if (content.images.length) return {kind:'session-prompt',content:withContext(''),extensions:[{kind:'skill',name:parsed.name}]};
      return {kind:'skill-selection',text:`/skill:${parsed.name}`};
    }
    if (parsed.kind === 'prompt') return {
      kind:parsed.action === 'new' ? 'new-task' : 'session-prompt',
      content:withContext(parsed.text),
      ...(parsed.extensions.length ? {extensions:parsed.extensions} : {}),
    };
    if (parsed.kind === 'command' && content.images.length) {
      const skill = context.skillAliases.get(parsed.action);
      if (skill) return {kind:'session-prompt',content:withContext(''),extensions:[{kind:'skill',name:skill.name}]};
    }
    return parsed;
  }
  if (!content.text.trim() && !content.images.length) return {kind:'ignore'};
  if (context.question) return {kind:'question-answer',token:context.question,text:content.text};
  if (context.endedQuestion) return {kind:'ended-question'};
  const directed = reply?.from?.id === context.botId && !('forum_topic_created' in reply) && reply.message_id !== message.message_thread_id;
  if (!context.allMessagesArePrompts && !directed) return {kind:'ignore'};
  if (directed) return {kind:'session-prompt',content:withContext(content.text)};
  let text = message.rich_message ? messageText(message,{id:context.botId,username:context.username})! : content.text;
  const entities = 'entities' in message ? message.entities ?? [] : message.caption_entities ?? [];
  for (const entity of [...entities].reverse()) {
    if ((entity.type === 'mention' && text.slice(entity.offset,entity.offset+entity.length).toLowerCase() === `@${context.username.toLowerCase()}`) ||
        (entity.type === 'text_mention' && entity.user.id === context.botId)) text = text.slice(0,entity.offset) + text.slice(entity.offset+entity.length);
  }
  text = text.trim();
  return text || content.images.length ? {kind:'session-prompt',content:{...content,text}} : {kind:'ignore'};
}
