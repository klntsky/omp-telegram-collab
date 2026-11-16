import type { Bot, Context } from 'grammy';
import type { PendingPromptContent, PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { ImageContent } from '@oh-my-pi/pi-wire';
import type { TelegramImage } from '../telegram-input.js';
import { findInstance, refreshTermination } from '../config.js';
import { realpathSync } from 'node:fs';
import { documentFileName, PermanentDocumentPreparationError, saveDocument } from './document-file.js';
import { join } from 'node:path';
import { sendTo } from '../telegram-destination.js';
import { topicDestination, type TopicDestination } from '../../shared/topic-destination.js';
import { PromptPreparationRejectedError } from './types.js';

export interface PromptPreparationDependencies {
  options: Pick<BotOptions, 'config' | 'store' | 'runtime'>;
  bot: Bot<Context>;
  token: string;
  id(): number;
  stopped(): boolean;
  authorize(chatId: number, userId: number): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
  requireSessionAssignment(session: TopicSession): void;
  dropListener(sessionId: string): void;
  replyPresetText(ctx: Context, text: string): Promise<void>;
}

export class PromptPreparation {
  constructor(private readonly deps: PromptPreparationDependencies) {}
  async promptImages(attachments: TelegramImage[]): Promise<ImageContent[]> {
    return Promise.all(attachments.map(async ({fileId,mimeType}): Promise<ImageContent> => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error(`Unsupported image type: ${mimeType}`);
      const file = await this.deps.bot.api.getFile(fileId);
      if (!file.file_path) throw new Error('Telegram image file path is unavailable');
      const environment = this.deps.bot.api.options?.environment === 'test' ? 'test/' : '';
      const response = await fetch(`https://api.telegram.org/file/bot${this.deps.token}/${environment}${file.file_path}`);
      if (!response.ok) throw new Error(`Telegram image download failed: ${response.status} ${response.statusText}\n${await response.text()}`);
      return {type:'image',data:Buffer.from(await response.arrayBuffer()).toString('base64'),mimeType};
    }));
  }
  async uploadDocuments(session: TopicSession, content: PendingPromptContent, authorize: () => Promise<void>, destination: TopicDestination, saved?: (remaining: PendingPromptContent) => void): Promise<PromptContent> {
    const {documents, ...prompt} = content;
    if (!documents?.length) return prompt;
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const check = async () => {
      await authorize();
      if (this.deps.stopped() || refreshTermination(this.deps.options.config)) throw new Error('The service is stopping');
      this.deps.requireSessionAssignment(session);
      if (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
          this.deps.options.store.getSession(session.id)?.status !== 'open')
        throw new Error('The session changed before document upload.');
    };
    let text = prompt.text;
    for (const [index, document] of documents.entries()) {
      const fileName = documentFileName(document.fileName);
      await check();
      const file = await this.deps.bot.api.getFile(document.fileId);
      if (!file.file_path) throw new Error('Telegram document file path is unavailable');
      const environment = this.deps.bot.api.options?.environment === 'test' ? 'test/' : '';
      const response = await fetch(`https://api.telegram.org/file/bot${this.deps.token}/${environment}${file.file_path}`);
      if (!response.ok) throw new Error(`Telegram document download failed: ${response.status} ${response.statusText}\n${await response.text()}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await check();
      const cwd = session.cwd;
      if (realpathSync(cwd) !== cwd) throw new PermanentDocumentPreparationError('Session working directory identity changed');
      const path = join(cwd, fileName);
      const overwritten = saveDocument(path, bytes);
      text = [text, `Attachment: ${JSON.stringify(fileName)} at ${JSON.stringify(path)}`].filter(Boolean).join('\n\n');
      saved?.({...prompt, text, documents: documents.slice(index + 1)});
      await sendTo(this.deps.bot.api, destination, `✅ Uploaded ${fileName} to ${path}${overwritten ? ', overwriting the old version' : ''}`);
    }
    return {...prompt, text};
  }
  defaultNewTopicSkills(chatId: number): string[] {
    return findInstance(this.deps.options.config,this.deps.id(),chatId)?.instance.chats
      .find(chat => chat.botId === this.deps.id() && chat.chatId === chatId)?.default_new_topic_skills?.slice() ?? [];
  }
  async preparePrompt(ctx: Context, session: TopicSession, extensions: readonly PromptExtension[], authority = ctx): Promise<void> {
    return this.prepareAuthorizedPrompt(session, extensions, async () => {
      await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.deps.currentAdmin(authority))) throw new Error('Prompt preparations require a group administrator.');
    }, text => this.deps.replyPresetText(ctx, text));
  }
  async prepareQueuedPrompt(session: TopicSession, extensions: readonly PromptExtension[], authorize: () => Promise<void>, checkpoint: (remaining: PromptExtension[], preset?: string) => void, preset?: string): Promise<void> {
    const requested = extensions.flatMap(extension => extension.kind === 'model-preset' && extension.name !== undefined ? [extension.name] : []);
    if (preset !== undefined) requested.push(preset);
    if (requested.length) {
      const names = await this.deps.options.runtime.availableModelPresets(session.instanceId, session.cwd);
      const missing = requested.find(name => !names.includes(name));
      if (missing !== undefined) throw new PromptPreparationRejectedError(`Unknown model preset: ${missing}. Available presets: ${names.join(', ') || '(none)'}\nPlease refine your request with an available preset.`);
    }
    await this.prepareAuthorizedPrompt(session, extensions, authorize,
      text => sendTo(this.deps.bot.api, topicDestination(session.chatId, session.threadId), text),
      checkpoint, preset);
  }
  async reportQueuedFailure(session: TopicSession, error: Error): Promise<void> {
    await sendTo(this.deps.bot.api, topicDestination(session.chatId, session.threadId), error.message);
  }
  private async prepareAuthorizedPrompt(session: TopicSession, extensions: readonly PromptExtension[], authorize: () => Promise<void>, report: (text: string) => Promise<unknown>, checkpoint?: (remaining: PromptExtension[], preset?: string) => void, queuedPreset?: string): Promise<void> {
    if (extensions.some(extension => extension.kind === 'model-preset' && extension.name === undefined))
      throw new Error('Choose a model preset before preparing the prompt.');
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const checkSession = () => {
      if (this.deps.stopped() || refreshTermination(this.deps.options.config)) throw new Error('The service is stopping');
      this.deps.requireSessionAssignment(session);
      if (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
          this.deps.options.store.getSession(session.id)?.status !== 'open') {
        throw new Error('The session changed before prompt preparation could finish');
      }
    };
    const applyPreset = async (name: string, applied?: () => void) => {
      const release = this.deps.options.runtime.retain(session.id);
      try {
        await authorize();
        checkSession();
        await this.deps.options.runtime.ensure(session);
        await authorize();
        checkSession();
        const text = await this.deps.options.runtime.modelPresets(session, name);
        applied?.();
        await report(text);
      } finally { release(); }
    };
    let selectedPreset = queuedPreset;
    if (selectedPreset !== undefined) {
      await authorize();
      checkSession();
      await applyPreset(selectedPreset);
    }
    for (const [index, extension] of extensions.entries()) {
      if (extension.kind === 'skill') continue;
      await authorize();
      checkSession();
      if (extension.kind === 'worktree') {
        let text: string;
        try {
          text = await this.deps.options.runtime.worktree(session, undefined, authorize);
          this.deps.options.store.setSessionCwd(session.id, session.cwd);
        } finally {
          this.deps.dropListener(session.id);
        }
        // A later preset or delivery failure must not replay the completed native worktree switch.
        checkpoint?.([
          ...(selectedPreset === undefined ? [] : [{kind: 'model-preset' as const, name: selectedPreset}]),
          ...extensions.slice(index + 1),
        ], selectedPreset);
        await report(`🌳 ${text}`);
        if (selectedPreset !== undefined) await applyPreset(selectedPreset, () => checkpoint?.(extensions.slice(index + 1), selectedPreset));
      } else {
        if (extension.name === undefined) throw new Error('Choose a model preset before preparing the prompt.');
        await applyPreset(extension.name, () => checkpoint?.(extensions.slice(index + 1), extension.name));
        selectedPreset = extension.name;
      }
      await authorize();
      checkSession();
    }
  }
  async createTopicWorktree(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<void> {
    this.deps.requireSessionAssignment(session);
    await this.deps.options.runtime.worktree(session, `t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`, beforeMutation);
    // Native worktree already guarded its mutations; checkpoint its completed effect
    // before another permission lookup can fail and cause recovery to replay it.
    this.deps.options.store.setSessionCwd(session.id, session.cwd);
  }
}
