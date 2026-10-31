import type { Context } from 'grammy';

export interface TelegramImage { fileId: string; mimeType: string }
export interface TelegramContent { text: string; images: TelegramImage[] }
export type InputIntent =
  | { kind: 'ignore' }
  | { kind: 'event' }
  | { kind: 'command'; action: string; argument: string }
  | { kind: 'skill-selection'; text: string }
  | { kind: 'question-answer'; token: string; text: string }
  | { kind: 'ended-question' }
  | { kind: 'new-task' | 'session-prompt'; content: TelegramContent; skill?: string; requestId?: number };

export interface InputContext {
  botId: number;
  username: string;
  allMessagesArePrompts: boolean;
  commands: ReadonlySet<string>;
  skillAliases: ReadonlyMap<string, { name: string }>;
  question?: string;
  endedQuestion: boolean;
  taskRequest: boolean;
}

export function normalizeMessage(messages: NonNullable<Context['message']>[]): TelegramContent {
  const texts: string[] = [];
  const images: TelegramImage[] = [];
  for (const message of messages) {
    const text = 'text' in message ? message.text : 'caption' in message ? message.caption : undefined;
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
    const quoted = reply && ('text' in reply ? reply.text : 'caption' in reply ? reply.caption : undefined);
    return quoted ? quoted.split(/\r?\n/).map(line => `> ${line}`).join('\n') : '';
  };
  const withContext = (text: string): TelegramContent => {
    const quoted = quote();
    return {...content,text:quoted ? text ? `${quoted}\n\n${text}` : quoted : text};
  };
  if (content.text.startsWith('/')) {
    if (/^\/skill:[^\s]+$/.test(content.text)) return {kind:'skill-selection',text:content.text};
    const command = content.text.match(/^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (!command || (command[2] && command[2].toLowerCase() !== context.username.toLowerCase())) return {kind:'ignore'};
    const action = command[1]!.toLowerCase();
    const argument = command[3]?.trim() ?? '';
    const skill = context.skillAliases.get(action);
    if (!context.commands.has(action) && !skill) return {kind:'ignore'};
    if (action === 'new' || action === 'p' || (skill && (argument || content.images.length))) {
      return {kind:action === 'new' ? 'new-task' : 'session-prompt',content:withContext(argument),...(skill ? {skill:skill.name} : {})};
    }
    return {kind:'command',action,argument};
  }
  if (!content.text.trim() && !content.images.length) return {kind:'ignore'};
  if (context.question) return {kind:'question-answer',token:context.question,text:content.text};
  if (context.endedQuestion) return {kind:'ended-question'};
  if (context.taskRequest && reply) return {kind:'new-task',content,requestId:reply.message_id};
  const directed = reply?.from?.id === context.botId && !('forum_topic_created' in reply) && reply.message_id !== message.message_thread_id;
  if (!context.allMessagesArePrompts && !directed) return {kind:'ignore'};
  if (directed) return {kind:'session-prompt',content:withContext(content.text)};
  let text = content.text;
  const entities = 'entities' in message ? message.entities ?? [] : message.caption_entities ?? [];
  for (const entity of [...entities].reverse()) {
    if ((entity.type === 'mention' && text.slice(entity.offset,entity.offset+entity.length).toLowerCase() === `@${context.username.toLowerCase()}`) ||
        (entity.type === 'text_mention' && entity.user.id === context.botId)) text = text.slice(0,entity.offset) + text.slice(entity.offset+entity.length);
  }
  text = text.trim();
  return text || content.images.length ? {kind:'session-prompt',content:{...content,text}} : {kind:'ignore'};
}
