import type { Context, Bot } from 'grammy';
import type { AppConfig } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { SettingsPanel, SettingsKey } from './types.js';
import type { TypingMode } from '../../shared/contracts.js';
import type { SettingsAction, SettingsPage } from './types.js';
import { isAbsolute, normalize } from 'node:path';
import { findInstance, writeConfig } from '../config.js';
import { typingLabels } from './settings-rendering.js';
import { SettingsPanelStore } from './settings-panel-store.js';

export interface SettingsMutationDependencies {
  id: () => number;
  config: AppConfig;
  runtime: Pick<BotOptions['runtime'], 'listSkills' | 'availableModelPresets' | 'setSessionLimit'>;
  panels: SettingsPanelStore;
  render: (panel: SettingsPanel, config: AppConfig, page?: SettingsPage, offset?: number) => Promise<void>;
  syncCommandMenus: () => Promise<void>;
}

export class SettingsMutations {
  constructor(private readonly deps: SettingsMutationDependencies) {}
  async saveReply(ctx: Context, panel: SettingsPanel): Promise<void> {
    if (panel.folderInput) {
      const input = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim() ?? '' : '';
      const paths = [...new Set(input.split('\n').map(path => path.trim()).filter(Boolean))];
      if (!paths.length || paths.some(path => isAbsolute(path) || path.includes('\0'))) throw new Error('Reply with relative folder paths, one per line.');
      const config = await this.deps.panels.access(ctx,panel,true);
      const chat = findInstance(config,this.deps.id(),panel.chatId)!.instance.chats.find(chat => chat.botId === this.deps.id() && chat.chatId === panel.chatId)!;
      const before = (chat.folder_options ?? []).join('\n') || '(none)';
      chat.folder_options = [...new Set([...(panel.folderInput === 'append' ? chat.folder_options ?? [] : []),...paths].map(path => normalize(path).replace(/\/+$/, '')))];
      panel.changes.set('folders',{label:'Runtime folders',before:panel.changes.get('folders')?.before ?? before,after:chat.folder_options.join('\n')});
      writeConfig(config);
      Object.assign(findInstance(this.deps.config,this.deps.id(),panel.chatId)!.instance.chats.find(chat => chat.botId === this.deps.id() && chat.chatId === panel.chatId)!,chat);
      this.deps.panels.save(panel);
      await this.deps.render(panel,config,'folders');
      return;
    }
    const input = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim() ?? '' : '';
    const target = Number(input);
    if (!/^[0-9]+$/.test(input) || !Number.isSafeInteger(target) || target < 1)
      throw new Error('The live session count limit must be a positive safe integer.');
    const config = await this.deps.panels.access(ctx, panel, true);
    const before = String(config.omp.maxSessions);
    config.omp.maxSessions = target;
    writeConfig(config);
    this.deps.config.omp.maxSessions = target;
    this.deps.runtime.setSessionLimit(target);
    const original = panel.changes.get('capacity')?.before ?? before;
    if (original === String(target)) panel.changes.delete('capacity');
    else panel.changes.set('capacity', {
      label: 'Maximum live sessions (service-wide)', before: original, after: String(target),
    });
    this.deps.panels.save(panel);
    await this.deps.render(panel, config, 'root');
  }
  async apply(ctx: Context, panel: SettingsPanel, action: Extract<SettingsAction, {kind: 'set' | 'default' | 'typing'}>): Promise<void> {
    const recordChange = (page: SettingsKey, label: string, before: string, after: string) => {
      const original = panel.changes.get(page)?.before ?? before;
      if (original === after) panel.changes.delete(page);
      else panel.changes.set(page, { label, before: original, after });
    };
      if (action.kind === 'default' && action.value !== undefined) {
        const names =
          action.field === 'default_new_topic_skill'
            ? (await this.deps.runtime.listSkills(panel.instanceId)).map((entry) => entry.name)
            : await this.deps.runtime.availableModelPresets(panel.instanceId);
        if (!names.includes(action.value))
          throw new Error(
            `Unknown ${action.field === 'default_new_topic_skill' ? 'skill' : 'model preset'}: ${action.value}`,
          );
      }
      const current = await this.deps.panels.access(ctx, panel, true);
      const chat = findInstance(current, this.deps.id(), panel.chatId)!.instance.chats.find(
        (chat) => chat.botId === this.deps.id() && chat.chatId === panel.chatId,
      )!;
      const page: SettingsKey =
        action.kind === 'typing'
          ? 'typing'
          : action.kind === 'default'
            ? action.field === 'default_new_topic_skill'
              ? 'skills'
              : 'presets'
            : action.field === 'all_messages_are_prompts'
              ? 'prompts'
              : action.field === 'users_can_propose_prompts'
                ? 'proposals'
                : 'worktrees';
      const labels = {
        prompts: 'Message handling',
        proposals: 'Who can send prompts',
        skills: 'Default skill',
        presets: 'Default model preset',
        worktrees: '🌳 Worktrees',
        typing: 'Typing indicators',
      };
      const value = (setting: boolean | string | undefined): string => {
        if (page === 'typing') return typingLabels[(setting ?? 'disabled') as TypingMode];
        if (action.kind === 'default')
          return setting === undefined
            ? page === 'skills'
              ? 'No default skill'
              : 'Use host default'
            : String(setting);
        if (page === 'prompts')
          return setting === false ? 'Commands and replies only' : 'All messages';
        if (page === 'proposals')
          return setting === true ? 'Members with admin approval' : 'Admins only';
        return setting === true ? 'Enabled' : 'Disabled';
      };
      const before = value(chat[action.field]);
      if (action.kind === 'typing') chat.typing_indicators = action.value;
      else if (action.kind === 'set') chat[action.field] = action.value;
      else if (action.value === undefined) delete chat[action.field];
      else chat[action.field] = action.value;
      writeConfig(current);
      recordChange(page, labels[page], before, value(chat[action.field]));
      this.deps.panels.save(panel);
      Object.assign(
        findInstance(this.deps.config, this.deps.id(), panel.chatId)!.instance.chats.find(
          (chat) => chat.botId === this.deps.id() && chat.chatId === panel.chatId,
        )!,
        chat,
      );
      if (action.kind === 'default' && action.value === undefined)
        delete findInstance(this.deps.config, this.deps.id(), panel.chatId)!.instance.chats.find(
          (chat) => chat.botId === this.deps.id() && chat.chatId === panel.chatId,
        )![action.field];
      await this.deps.syncCommandMenus();
      const offset = action.kind === 'default' ? panel.offset : 0;
      await this.deps.render(
        panel,
        current,
        action.kind === 'typing'
          ? 'typing'
          : action.kind === 'set'
            ? 'root'
            : action.field === 'default_new_topic_skill'
              ? 'skills'
              : 'presets',
        offset,
      );
      return;
  }
}
