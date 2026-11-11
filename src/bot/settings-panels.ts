import { randomBytes } from 'node:crypto';
import type { Bot, Context } from 'grammy';
import type { AppConfig } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { SettingsPanel, SettingsPage } from './types.js';
import { findInstance, writeConfig } from '../config.js';
import { sameTopicDestination } from '../../shared/topic-destination.js';
import { contextDestination, replyTo } from '../telegram-destination.js';
import { SettingsPanelStore } from './settings-panel-store.js';
import { SettingsMutations } from './settings-mutations.js';
import { renderSettings } from './settings-rendering.js';

export interface SettingsDependencies {
  id: () => number;
  api: Bot<Context>['api'];
  config: AppConfig;
  runtime: Pick<BotOptions['runtime'], 'listSkills' | 'availableModelPresets' | 'getSessionLimit' | 'setSessionLimit'>;
  panels: SettingsPanelStore;
  assignedId: (chatId: number) => number;
  currentAdmin: (ctx: Context) => Promise<boolean>;
  syncCommandMenus: () => Promise<void>;
}

export class SettingsPanels {
  private readonly mutations: SettingsMutations;
  constructor(private readonly deps: SettingsDependencies) {
    this.mutations = new SettingsMutations({
      id: deps.id, config: deps.config, runtime: deps.runtime, panels: deps.panels,
      render: (panel, config, page, offset) => this.render(panel, config, page, offset),
      syncCommandMenus: deps.syncCommandMenus,
    });
  }
  saveReply(ctx: Context, panel: SettingsPanel): Promise<void> {
    return this.mutations.saveReply(ctx, panel);
  }
  private render(panel: SettingsPanel, config: AppConfig, page?: SettingsPage, offset?: number): Promise<void> {
    return renderSettings({id: this.deps.id, api: this.deps.api, runtime: this.deps.runtime,
      assignedId: this.deps.assignedId, save: panel => this.deps.panels.save(panel)}, panel, config, page, offset);
  }
  async open(ctx: Context): Promise<void> {
    if (!(await this.deps.currentAdmin(ctx))) {
      await replyTo(ctx, contextDestination(ctx), 'Settings require a current group owner or administrator.');
      return;
    }
    const panel: SettingsPanel = {
      token: randomBytes(16).toString('base64url'), chatId: ctx.chat!.id,
      destination: contextDestination(ctx), messageId: 0, instanceId: this.deps.assignedId(ctx.chat!.id),
      revision: 0, offset: 0, choices: [], changes: new Map(),
    };
    const persisted = await this.deps.panels.access(ctx, panel);
    await this.render(panel, persisted);
  }
  async callback(ctx: Context, data: string): Promise<void> {
    const match = data.match(/^settings:([A-Za-z0-9_-]{22}):(\d+):(\d+)$/);
    const panel = match ? this.deps.panels.load(match[1]!) : undefined;
    const message =
      ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (
      !match ||
      !message ||
      !ctx.chat ||
      ctx.chat.type !== 'supergroup' ||
      !('from' in message) ||
      message.from?.id !== this.deps.id() ||
      'forward_origin' in message ||
      'forward_date' in message
    )
      return;
    if (!panel) {
      const recovered: SettingsPanel = {
        token: match[1]!,
        chatId: ctx.chat.id,
        destination: contextDestination(ctx),
        messageId: message.message_id,
        instanceId: this.deps.assignedId(ctx.chat.id),
        revision: Number(match[2]),
        offset: 0,
        choices: [],
        changes: new Map(),
      };
      const config = await this.deps.panels.access(ctx, recovered);
      await this.render(recovered, config);
      await ctx.answerCallbackQuery();
      return;
    }
    if (
      ctx.chat.id !== panel.chatId ||
      message.message_id !== panel.messageId ||
      !sameTopicDestination(contextDestination(ctx), panel.destination)
    )
      return;
    if (Number(match[2]) !== panel.revision) {
      const config = await this.deps.panels.access(ctx, panel);
      await this.render(panel, config);
      await ctx.answerCallbackQuery();
      return;
    }
    const action = panel.choices[Number(match![3])];
    if (!action) return;
    if (action.kind === 'set' && !['all_messages_are_prompts','users_can_propose_prompts','create_topic_worktrees'].includes(action.field)) {
      await ctx.answerCallbackQuery('This setting is no longer available. Open /settings again.');
      return;
    }
    if (action.kind === 'folders') {
      const config = await this.deps.panels.access(ctx,panel,true);
      if (action.input) {
        panel.folderInput = action.input;
        panel.revision++;
        panel.choices = [{kind:'page',page:'folders'}];
        this.deps.panels.save(panel);
        await ctx.answerCallbackQuery();
        await this.deps.api.editMessageText(panel.chatId,panel.messageId,
          action.input === 'append' ? 'Reply to this message with paths relative to the forum instance, one per line, to add folders.' : 'Reply to this message with paths relative to the forum instance, one per line, to replace all folders.',
          {reply_markup:{inline_keyboard:[[{text:'Cancel',callback_data:`settings:${panel.token}:${panel.revision}:0`}]]}});
        return;
      }
      const chat = findInstance(config,this.deps.id(),panel.chatId)!.instance.chats.find(chat => chat.botId === this.deps.id() && chat.chatId === panel.chatId)!;
      const before = (chat.folder_options ?? []).join('\n') || '(none)';
      chat.folder_options = action.clear ? [] : (chat.folder_options ?? []).filter((_,index) => index !== action.remove);
      panel.changes.set('folders',{label:'Runtime folders',before:panel.changes.get('folders')?.before ?? before,after:chat.folder_options.join('\n') || '(none)'});
      writeConfig(config);
      Object.assign(findInstance(this.deps.config,this.deps.id(),panel.chatId)!.instance.chats.find(chat => chat.botId === this.deps.id() && chat.chatId === panel.chatId)!,chat);
      this.deps.panels.save(panel);
      await ctx.answerCallbackQuery();
      await this.render(panel,config,'folders');
      return;
    }
    const config = await this.deps.panels.access(
      ctx,
      panel,
      action.kind === 'set' ||
        action.kind === 'default' ||
        action.kind === 'typing',
    );
    if (action.kind === 'close') {
      const changes = [...panel.changes.values()].map(
        ({ label, before, after }) => `${label}: ${before.slice(0, 200)} → ${after.slice(0, 200)}`,
      );
      const summary = changes.length
        ? `Settings closed.\n\nSaved changes\n${changes.join('\n')}`
        : 'Settings closed.\nNo settings changed.';
      await this.deps.api.editMessageText(panel.chatId, panel.messageId, summary, {
        reply_markup: { inline_keyboard: [] },
      });
      panel.choices = [];
      panel.capacityInput = false;
      panel.folderInput = undefined;
      this.deps.panels.save(panel);
      return;
    }
    if (action.kind === 'page') {
      await this.render(panel, config, action.page, action.offset);
      return;
    }
    await this.mutations.apply(ctx, panel, action);
  }
}
