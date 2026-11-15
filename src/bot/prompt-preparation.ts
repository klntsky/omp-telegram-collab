import { BotPromptRejectedError, BotSessionStateError, BotWorkingDirectoryError } from './errors.js';
import { AuthorizationDeniedError } from './types.js';
import { redactTelegramFailure } from '../telegram-errors.js';
import type { Bot, Context } from 'grammy';
import type { PendingPromptContent, PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { ImageContent } from '@oh-my-pi/pi-wire';
import type { TelegramImage } from '../telegram-input.js';
import { findInstance, refreshTermination } from '../config.js';
import { realpathSync } from 'node:fs';
import { saveDocument } from './document-file.js';
import { basename, join } from 'node:path';
import { sendTo } from '../telegram-destination.js';
import { topicDestination, type TopicDestination } from '../../shared/topic-destination.js';
import type { InitialDocumentSetup } from '../store/initial-documents.js';
import { TelegramFileDownloadError } from '../telegram-errors.js';

class PromptAttachmentError extends Error {}

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
  private async downloadFile(filePath: string, kind: 'image' | 'document', fileId: string): Promise<ArrayBuffer> {
    const context = `Telegram ${kind} download (bot=${this.deps.id()}, file=${fileId})`;
    try {
      const environment = this.deps.bot.api.options?.environment === 'test' ? 'test/' : '';
      const response = await fetch(`https://api.telegram.org/file/bot${this.deps.token}/${environment}${filePath}`);
      if (!response.ok) throw new TelegramFileDownloadError(`Telegram ${kind} download failed: ${response.status} ${response.statusText}\n${await response.text()}`);
      return await response.arrayBuffer();
    } catch (error) {
      redactTelegramFailure(error, this.deps.token);
      // File URLs include the bot token; describe the attachment, never the request URL.
      if (error instanceof Error) error.message = `${context}: ${error.message}`;
      throw error;
    }
  }
  async promptImages(attachments: TelegramImage[]): Promise<ImageContent[]> {
    const results = await Promise.allSettled(attachments.map(async ({fileId,mimeType}): Promise<ImageContent> => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) throw new PromptAttachmentError(`Prepare Telegram image (file=${fileId}): Unsupported image type: ${mimeType}`);
      const file = await this.deps.bot.api.getFile(fileId);
      if (!file.file_path) throw new PromptAttachmentError(`Prepare Telegram image (file=${fileId}): Telegram image file path is unavailable`);
      return {type:'image',data:Buffer.from(await this.downloadFile(file.file_path, 'image', fileId)).toString('base64'),mimeType};
    }));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, `Prepare Telegram image attachments (bot=${this.deps.id()}):\n${errors.map(error => error instanceof Error ? error.message : String(error)).join('\n')}`);
    return results.map(result => (result as PromiseFulfilledResult<ImageContent>).value);
  }
  async uploadDocuments(session: TopicSession, content: PendingPromptContent, authorize: () => Promise<void>, destination: TopicDestination, saved?: (remaining: PendingPromptContent) => void): Promise<PromptContent> {
    const {documents, ...prompt} = content;
    if (!documents?.length) return prompt;
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const check = async () => {
      await authorize();
      if (this.deps.stopped() || refreshTermination(this.deps.options.config)) throw new BotSessionStateError(`Upload documents (session=${session.id}): The service is stopping`);
      this.deps.requireSessionAssignment(session);
      if (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
          this.deps.options.store.getSession(session.id)?.status !== 'open')
        throw new BotSessionStateError(`Upload documents (session=${session.id}): The session changed before document upload.`);
    };
    let text = prompt.text;
    for (const [index, document] of documents.entries()) {
      const fileName = basename(document.fileName.replaceAll('\\', '/'));
      if (!fileName || fileName === '.' || fileName === '..' || /[\x00-\x1f\x7f]/.test(fileName))
        throw new PromptAttachmentError(`Prepare document upload (session=${session.id}): The document filename is unsafe.`);
      await check();
      const file = await this.deps.bot.api.getFile(document.fileId);
      if (!file.file_path) throw new PromptAttachmentError(`Prepare document upload (session=${session.id}, file=${document.fileId}): Telegram document file path is unavailable`);
      const bytes = new Uint8Array(await this.downloadFile(file.file_path, 'document', document.fileId));
      await check();
      const cwd = session.cwd;
      if (realpathSync(cwd) !== cwd) throw new BotWorkingDirectoryError(`Upload documents (session=${session.id}, path=${cwd}): Session working directory identity changed`);
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
      if (!(await this.deps.currentAdmin(authority))) throw new AuthorizationDeniedError(`Prepare prompt (session=${session.id}, user=${authority.from!.id}): Prompt preparations require a group administrator.`);
    }, text => this.deps.replyPresetText(ctx, text));
  }
  async prepareInitialDocuments(session: TopicSession, authorize: () => Promise<void>): Promise<void> {
    const setup = this.deps.options.store.getInitialDocumentSetup(session.id);
    if (!setup) return;
    if (setup.automaticWorktree) {
      await authorize();
      await this.createTopicWorktree(session, authorize);
      setup.automaticWorktree = false;
      this.deps.options.store.setInitialDocumentSetup(session.id, setup);
    }
    if (setup.extensions.length || setup.preset !== undefined) await this.prepareAuthorizedPrompt(
      session, setup.extensions, authorize,
      text => sendTo(this.deps.bot.api, topicDestination(session.chatId, session.threadId), text), setup,
    );
    this.deps.options.store.setInitialDocumentSetup(session.id, undefined);
  }
  private async prepareAuthorizedPrompt(session: TopicSession, extensions: readonly PromptExtension[], authorize: () => Promise<void>, report: (text: string) => Promise<unknown>, setup?: InitialDocumentSetup): Promise<void> {
    if (extensions.some(extension => extension.kind === 'model-preset' && extension.name === undefined))
      throw new BotPromptRejectedError(`Prepare prompt (session=${session.id}): Choose a model preset before preparing the prompt.`);
    const generation = this.deps.options.store.getSessionGeneration(session.id);
    const checkSession = () => {
      if (this.deps.stopped() || refreshTermination(this.deps.options.config)) throw new BotSessionStateError(`Prepare prompt (session=${session.id}): The service is stopping`);
      this.deps.requireSessionAssignment(session);
      if (this.deps.options.store.getSessionGeneration(session.id) !== generation ||
          this.deps.options.store.getSession(session.id)?.status !== 'open') {
        throw new BotSessionStateError(`Prepare prompt (session=${session.id}): The session changed before prompt preparation could finish`);
      }
    };
    const applyPreset = async (name: string) => {
      const release = this.deps.options.runtime.retain(session.id);
      try {
        await this.deps.options.runtime.ensure(session);
        await authorize();
        checkSession();
        const text = await this.deps.options.runtime.modelPresets(session, name);
        await report(text);
      } finally { release(); }
    };
    let selectedPreset = setup?.preset;
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
          checkSession();
          this.deps.options.store.setSessionCwd(session.id, session.cwd);
        } finally {
          this.deps.dropListener(session.id);
        }
        // A later preset or delivery failure must not replay the completed native worktree switch.
        if (setup) {
          setup.extensions = extensions.slice(index + 1);
          setup.preset = selectedPreset;
          this.deps.options.store.setInitialDocumentSetup(session.id, setup);
        }
        await report(`🌳 ${text}`);
        if (selectedPreset !== undefined) await applyPreset(selectedPreset);
      } else {
        if (extension.name === undefined) throw new BotPromptRejectedError(`Prepare prompt (session=${session.id}): Choose a model preset before preparing the prompt.`);
        await applyPreset(extension.name);
        selectedPreset = extension.name;
      }
      if (setup) {
        setup.extensions = extensions.slice(index + 1);
        setup.preset = selectedPreset;
        this.deps.options.store.setInitialDocumentSetup(session.id, setup);
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
