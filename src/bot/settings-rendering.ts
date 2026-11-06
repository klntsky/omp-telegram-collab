import type { Bot, Context } from 'grammy';
import type { AppConfig, TypingMode } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { SettingsPanel, SettingsPage, SettingsAction } from './types.js';
import { findInstance } from '../config.js';
import { isMentionableSkillName } from '../skill-commands.js';
import { sendTo } from '../telegram-destination.js';

export const typingLabels: Record<TypingMode, string> = {
  disabled: 'Disabled',
  streaming: 'While typing',
  inference: 'While working',
};

export interface SettingsRendering {
  id: () => number;
  api: Bot<Context>['api'];
  runtime: Pick<BotOptions['runtime'], 'listSkills' | 'availableModelPresets' | 'getSessionLimit'>;
  assignedId: (chatId: number) => number;
  save: (panel: SettingsPanel) => void;
}

export async function renderSettings(
    deps: SettingsRendering,
    panel: SettingsPanel,
    config: AppConfig,
    page: SettingsPage = 'root',
    offset = 0,
  ): Promise<void> {
    const assigned = findInstance(config, deps.id(), panel.chatId)!;
    const chat = assigned.instance.chats.find(
      (chat) => chat.botId === deps.id() && chat.chatId === panel.chatId,
    )!;
    const rows: { text: string; callback_data: string }[][] = [];
    const choices: SettingsAction[] = [];
    const revision = panel.revision + 1;
    const button = (text: string, action: SettingsAction, current = false) => {
      const index = choices.push(action) - 1;
      rows.push([
        {
          text: current ? `${text.slice(0, 90)} (current)` : text.slice(0, 100),
          callback_data: `settings:${panel.token}:${revision}:${index}`,
        },
      ]);
    };
    let text = 'Settings\nApplies to this group unless marked service-wide.';
    if (page === 'root') {
      button(
        `Message handling: ${chat.all_messages_are_prompts === false ? 'Commands and replies only' : 'All messages'}`,
        {
          kind: 'set',
          field: 'all_messages_are_prompts',
          value: chat.all_messages_are_prompts === false,
        },
      );
      button(
        `Who can send requests: ${chat.users_can_propose_prompts === true ? 'Members with admin approval' : 'Admins only'}`,
        {
          kind: 'set',
          field: 'users_can_propose_prompts',
          value: chat.users_can_propose_prompts !== true,
        },
      );
      button(`Default skill: ${chat.default_new_topic_skill ?? 'No default skill'}`, {
        kind: 'page',
        page: 'skills',
      });
      button(`Default model preset: ${chat.default_model_preset ?? 'Use host default'}`, {
        kind: 'page',
        page: 'presets',
      });
      button(`Maximum live sessions: ${config.omp.maxSessions} (service-wide)`, {
        kind: 'page',
        page: 'capacity',
      });
      button(`🌳 Worktrees: ${chat.create_topic_worktrees === true ? 'Enabled' : 'Disabled'}`, {
        kind: 'set',
        field: 'create_topic_worktrees',
        value: chat.create_topic_worktrees !== true,
      });
      button(`Typing indicators: ${typingLabels[chat.typing_indicators ?? 'disabled']}`, {
        kind: 'page',
        page: 'typing',
      });
      button('Runtime folders', {kind:'page',page:'folders'});
    } else if (page === 'folders') {
      const folders = chat.folder_options ?? [];
      const sole = folders[0] ?? '.';
      const summary = folders.length > 1 ? 'Ask when starting a session.' : `Uses ${sole === '.' ? '<Default>' : sole}.`;
      text = `Runtime folders\n${summary}\nUse Add folder to append paths, or Replace folders to explicitly replace the list.\n${folders.slice(offset,offset+8).map(path => path === '.' ? '<Default>' : path.slice(0,250)).join('\n') || '(no explicit folders)'}`;
      folders.slice(offset,offset+8).forEach((path,index) => button(`Remove ${path === '.' ? '<Default>' : path}`,{kind:'folders',remove:offset+index}));
      if (offset > 0) button('Previous folders',{kind:'page',page:'folders',offset:Math.max(0,offset-8)});
      if (offset+8 < (chat.folder_options ?? []).length) button('Next folders',{kind:'page',page:'folders',offset:offset+8});
      button('Clear folders',{kind:'folders',clear:true});
      button('Add folder',{kind:'folders',input:'append'});
      button('Replace folders',{kind:'folders',input:'replace'});
    } else if (page === 'typing') {
      text =
        'Typing indicators\nApplies to this group.\nBest-effort indicators may be skipped when delivery is busy.';
      for (const value of ['disabled', 'streaming', 'inference'] as const) {
        button(
          typingLabels[value],
          { kind: 'typing', field: 'typing_indicators', value },
          (chat.typing_indicators ?? 'disabled') === value,
        );
      }
    } else if (page === 'skills' || page === 'presets') {
      const skill = page === 'skills';
      const names = skill
        ? (await deps.runtime.listSkills(panel.instanceId))
            .map((entry) => entry.name)
            .filter(isMentionableSkillName)
        : await deps.runtime.availableModelPresets(panel.instanceId);
      if (deps.assignedId(panel.chatId) !== panel.instanceId)
        throw new Error('The group instance assignment changed');
      const field = skill ? 'default_new_topic_skill' : 'default_model_preset';
      text = `${skill ? 'Default skill' : 'Default model preset'}\nApplies to this group.\nCurrent choice: ${chat[field] ?? (skill ? 'No default skill' : 'Use host default')}\n${names.length ? `Choices ${offset + 1}–${Math.min(offset + 8, names.length)} of ${names.length}.` : 'No named choices available.'}\n${skill ? 'New topics use this skill. Existing topics are unchanged.' : 'The preset applies when a managed host next starts. Running hosts are unchanged.'}`;
      for (const name of names.slice(offset, offset + 8))
        button(name, { kind: 'default', field, value: name }, chat[field] === name);
      button(
        skill ? 'No default skill' : 'Use host default',
        { kind: 'default', field },
        chat[field] === undefined,
      );
      if (offset > 0) button('Previous', { kind: 'page', page, offset: Math.max(0, offset - 8) });
      if (offset + 8 < names.length) button('Next', { kind: 'page', page, offset: offset + 8 });
    } else {
      text = `Maximum live sessions: ${deps.runtime.getSessionLimit()}\nService-wide.\nReply to this message with a positive whole number to save the limit immediately.`;
    }
    if (page !== 'root')
      button(page === 'capacity' ? '⬅️ Back' : 'Back to settings', {
        kind: 'page',
        page: 'root',
      });
    if (page !== 'capacity') button('⬅️ Back', { kind: 'close' });
    const body = text.startsWith('Settings\n') ? text : `Settings\n${text}`;
    const extra = { reply_markup: { inline_keyboard: rows } };
    if (panel.messageId === 0) {
      const message = await sendTo(deps.api, panel.destination, body, extra);
      panel.messageId = message.message_id;
    } else {
      await deps.api.editMessageText(panel.chatId, panel.messageId, body, extra);
    }
    panel.choices = choices;
    panel.revision = revision;
    panel.offset = offset;
    panel.capacityInput = page === 'capacity';
    if (panel.folderInput) panel.folderInputEnded = true;
    panel.folderInput = undefined;
    deps.save(panel);
  }
