import { contextDestination, replyTo } from '../telegram-destination.js';
import type { Context } from 'grammy';
import type { TopicSession, PendingPromptContent } from '../../shared/contracts.js';
import type { ImageContent, CollabUiRequest } from '@oh-my-pi/pi-wire';
import type { InputIntent, TelegramImage } from '../telegram-input.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { SkillPicker } from '../skill-picker.js';
import type { BotOptions } from '../bot.js';
import type { MessageContext } from './input-router.js';
import type { TopicDestination } from '../../shared/topic-destination.js';



export interface InputPromptsDependencies {
  assignedId(chatId: number): number;
  authorize(chatId: number, userId: number, statusOnly?: boolean): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
  folderSettings(chatId: number): { instanceId: number; defaultDir: string; options: string[]; };
  store: BotOptions['store'];
  promptImages(attachments: TelegramImage[]): Promise<ImageContent[]>;
  requestKind(token: string): CollabUiRequest['kind'] | undefined;
  routePrompt(ctx: Context, content: PendingPromptContent, session?: TopicSession, extensions?: readonly PromptExtension[], worktree?: boolean, frozenSkills?: { names: string[]; topicSkills: string[]; }, cwd?: string): Promise<void>;
  skills: SkillPicker;
  submitAnswer(token: string, value?: string, receipt?: string, messageId?: number): void;
  usersCanProposePrompts(chatId: number): boolean;
}

export async function routePrompts(deps: InputPromptsDependencies, ctx: MessageContext, intent: InputIntent, session: TopicSession | undefined, destination: TopicDestination, detached: boolean, command: { action: string; argument: string } | undefined): Promise<boolean> {
  const message = ctx.message;
    if (!ctx.from || ctx.from.is_bot) return true;
    if (
      session?.status === 'closed' &&
      !['status', 'help', 'detach'].includes(command?.action ?? '')
    ) {
      await replyTo(
        ctx,
        destination,
        'This topic is closed. Reopen it in Telegram before sending work.',
      );
      return true;
    }
    if (detached && (intent.kind === 'question-answer' || intent.kind === 'ended-question')) return true;
    if (intent.kind === 'question-answer') {
      await deps.authorize(ctx.chat.id, ctx.from.id);
      const kind = deps.requestKind(intent.token);
      if (kind === undefined) {
        await replyTo(
          ctx,
          destination,
          'This question is no longer active. Answer the latest question instead.',
        );
        return true;
      }
      if (kind === 'editor')
        deps.submitAnswer(intent.token, intent.text, undefined, message.message_id);
      else await replyTo(ctx, destination, 'Use the numbered answer buttons on the question.');
      return true;
    }
    if (intent.kind === 'ended-question') {
      await deps.authorize(ctx.chat.id, ctx.from.id);
      await replyTo(
        ctx,
        destination,
        'This question is no longer active. Answer the latest question instead.',
      );
      return true;
    }
    if (intent.kind === 'invalid') {
      await replyTo(ctx, destination, intent.error.message);
      return true;
    }
    if (intent.kind === 'skill-selection') {
      if (!detached) await deps.skills.selection(ctx, intent.text, session);
      return true;
    }
    if (intent.kind === 'new-task' || intent.kind === 'session-prompt') {
      if (detached && intent.kind !== 'new-task') return true;
      if (intent.kind === 'session-prompt' && destination.kind !== 'general' && !session) {
        await replyTo(ctx, destination, 'No session in this topic. Use /new to create one.');
        return true;
      }
      if (!deps.usersCanProposePrompts(ctx.chat.id) && !(await deps.currentAdmin(ctx))) return true;
      if (!intent.content.text.trim() && !intent.content.images.length && !intent.content.documents?.length) {
        await replyTo(ctx, destination, intent.kind === 'new-task' ? 'Usage: /new <prompt>' : 'Usage: /p <prompt>');
        if (!intent.extensions?.some(extension => extension.kind !== 'skill')) return true;
      }
      await deps.authorize(ctx.chat.id, ctx.from.id);
      const instanceId = deps.assignedId(ctx.chat.id);
      const folderFingerprint = intent.kind === 'new-task' || !session ? JSON.stringify(deps.folderSettings(ctx.chat.id)) : undefined;
      const generation = session && deps.store.getSessionGeneration(session.id);
      const images = await deps.promptImages(intent.content.images);
      if (
        deps.assignedId(ctx.chat.id) !== instanceId ||
        (folderFingerprint !== undefined && folderFingerprint !== JSON.stringify(deps.folderSettings(ctx.chat.id))) ||
        (session && deps.store.getSessionGeneration(session.id) !== generation)
      )
        throw new Error('The session or group assignment changed while downloading the image');
      await deps.routePrompt(
        ctx,
        { text: intent.content.text, ...(images.length ? { images } : {}), ...(intent.content.documents?.length ? {documents:intent.content.documents} : {}) },
        intent.kind === 'new-task' ? undefined : session,
        intent.extensions,
      );
      return true;
    }
  return false;
}
