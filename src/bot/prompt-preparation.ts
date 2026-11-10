import type { Bot, Context } from 'grammy';
import type { PendingPromptContent, PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { ImageContent } from '@oh-my-pi/pi-wire';
import type { TelegramImage } from '../telegram-input.js';
import { findInstance, refreshTermination } from '../config.js';
import { constants, closeSync, fstatSync, ftruncateSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contextDestination, replyTo } from '../telegram-destination.js';

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
  async uploadDocuments(ctx: Context, session: TopicSession, content: PendingPromptContent, authority: Context): Promise<PromptContent> {
    const {documents, ...prompt} = content;
    if (!documents?.length) return prompt;
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const check = async () => {
      await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.deps.currentAdmin(authority))) throw new Error('Administrator access changed before document upload.');
      if (this.deps.stopped() || refreshTermination(this.deps.options.config)) throw new Error('The service is stopping');
      this.deps.requireSessionAssignment(session);
      if (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
          this.deps.options.store.getSession(session.id)?.status !== 'open')
        throw new Error('The session changed before document upload.');
    };
    const attachments: string[] = [];
    for (const document of documents) {
      const fileName = basename(document.fileName.replaceAll('\\', '/'));
      if (!fileName || fileName === '.' || fileName === '..' || /[\x00-\x1f\x7f]/.test(fileName))
        throw new Error('The document filename is unsafe.');
      await check();
      const file = await this.deps.bot.api.getFile(document.fileId);
      if (!file.file_path) throw new Error('Telegram document file path is unavailable');
      const environment = this.deps.bot.api.options?.environment === 'test' ? 'test/' : '';
      const response = await fetch(`https://api.telegram.org/file/bot${this.deps.token}/${environment}${file.file_path}`);
      if (!response.ok) throw new Error(`Telegram document download failed: ${response.status} ${response.statusText}\n${await response.text()}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await check();
      const cwd = session.cwd;
      if (realpathSync(cwd) !== cwd) throw new Error('Session working directory identity changed');
      const path = join(cwd, fileName);
      let overwritten = false;
      let fd: number;
      // Never follow a destination symlink or block on a FIFO before checking its type.
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        overwritten = true;
      }
      try {
        if (!fstatSync(fd).isFile()) throw new Error('The document destination is not a regular file.');
        if (overwritten) ftruncateSync(fd, 0);
        writeFileSync(fd, bytes);
      } catch (error) {
        try { closeSync(fd); } catch (closeError) {
          throw new AggregateError([error, closeError], [error, closeError].map(failure => failure instanceof Error ? failure.message : String(failure)).join('\n'));
        }
        throw error;
      }
      closeSync(fd);
      await replyTo(ctx, contextDestination(ctx), `✅ Uploaded ${fileName} to ${path}${overwritten ? ', overwriting the old version' : ''}`);
      attachments.push(`Attachment: ${JSON.stringify(fileName)} at ${JSON.stringify(path)}`);
    }
    return {...prompt, text:[prompt.text, ...attachments].filter(Boolean).join('\n\n')};
  }
  defaultNewTopicSkill(chatId: number): string | undefined {
    return findInstance(this.deps.options.config,this.deps.id(),chatId)?.instance.chats
      .find(chat => chat.botId === this.deps.id() && chat.chatId === chatId)?.default_new_topic_skill;
  }
  async preparePrompt(ctx: Context, session: TopicSession, extensions: readonly PromptExtension[], authority = ctx): Promise<void> {
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
    const applyPreset = async (name: string) => {
      const release = this.deps.options.runtime.retain(session.id);
      try {
        await this.deps.options.runtime.ensure(session);
        await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
        if (!(await this.deps.currentAdmin(authority))) throw new Error('Prompt preparations require a group administrator.');
        checkSession();
        await this.deps.options.runtime.modelPresets(session, name);
      } finally { release(); }
    };
    let selectedPreset: string | undefined;
    for (const extension of extensions) {
      if (extension.kind === 'skill') continue;
      await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.deps.currentAdmin(authority))) throw new Error('Prompt preparations require a group administrator.');
      checkSession();
      if (extension.kind === 'worktree') {
        try {
          await this.deps.options.runtime.worktree(session);
          checkSession();
          this.deps.options.store.setSessionCwd(session.id, session.cwd);
        } finally {
          this.deps.dropListener(session.id);
        }
        if (selectedPreset !== undefined) await applyPreset(selectedPreset);
      } else {
        if (extension.name === undefined) throw new Error('Choose a model preset before preparing the prompt.');
        await applyPreset(extension.name);
        selectedPreset = extension.name;
      }
      await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.deps.currentAdmin(authority))) throw new Error('Prompt preparations require a group administrator.');
      checkSession();
    }
  }
  async createTopicWorktree(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<void> {
    this.deps.requireSessionAssignment(session);
    await this.deps.options.runtime.worktree(session, `t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`, beforeMutation);
    await beforeMutation?.();
    this.deps.options.store.setSessionCwd(session.id, session.cwd);
  }
}
