import type { Bot, Context } from 'grammy';
import type { PromptContent, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { ImageContent } from '@oh-my-pi/pi-wire';
import type { TelegramImage } from '../telegram-input.js';
import { findInstance, refreshTermination } from '../config.js';
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
        const text = await this.deps.options.runtime.modelPresets(session, name);
        await this.deps.replyPresetText(ctx, text);
      } finally { release(); }
    };
    let selectedPreset: string | undefined;
    for (const extension of extensions) {
      if (extension.kind === 'skill') continue;
      await this.deps.authorize(ctx.chat!.id, ctx.from!.id);
      if (!(await this.deps.currentAdmin(authority))) throw new Error('Prompt preparations require a group administrator.');
      checkSession();
      if (extension.kind === 'worktree') {
        let text: string;
        try {
          text = await this.deps.options.runtime.worktree(session);
          checkSession();
          this.deps.options.store.setSessionCwd(session.id, session.cwd);
        } finally {
          this.deps.dropListener(session.id);
        }
        await replyTo(ctx, contextDestination(ctx), `🌳 ${text}`);
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
