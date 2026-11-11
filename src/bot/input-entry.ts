import { contextDestination, replyTo } from '../telegram-destination.js';
import type { Bot, Context } from 'grammy';
import type { InputIntent } from '../telegram-input.js';
import type { SkillPicker } from '../skill-picker.js';
import type { SettingsPanel } from './types.js';
import type { BotOptions } from '../bot.js';
import { findInstance, readConfig, writeConfig, refreshTermination } from '../config.js';
import { isAdministrator } from '../auth.js';

import { terminationMessage } from './commands.js';

export interface InputEntryDependencies {
  answerQuestion(ctx: Context, token: string, choice: string): Promise<void>;
  applyTermination(): Promise<void>;
  approvePrompt(ctx: Context, token: string): Promise<void>;
  assignedId(chatId: number): number;
  bot: Bot<Context>;
  commandHelp(chatId: number, admin: boolean): string;
  confirmCapacity(ctx: Context, action: string, token: string): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
  folderCallback(ctx: Context, data: string): Promise<void>;
  readonly id: number;
  openSettings(ctx: Context): Promise<void>;
  config: BotOptions['config'];
  store: BotOptions['store'];
  presetCallback(ctx: Context, data: string): Promise<void>;
  saveSettingsReply(ctx: Context, panel: SettingsPanel): Promise<void>;
  settingsCallback(ctx: Context, data: string): Promise<void>;
  settingsReplyPanel(ctx: Context): SettingsPanel | undefined;
  setup(ctx: Context): Promise<void>;
  showStatus(ctx: Context): Promise<void>;
  skills: SkillPicker;
  readonly stopped: boolean;
  clearTermination(): void;
}

export async function routeEntry(deps: InputEntryDependencies, ctx: Context, intent: InputIntent): Promise<ReturnType<typeof findInstance>> {
    if (deps.stopped || intent.kind === 'ignore') return undefined;
    if (intent.kind === 'command' && intent.action === 'status' && ctx.chat?.type !== 'private') {
      if (intent.argument) {
        await replyTo(ctx, contextDestination(ctx), 'Usage: /status');
        return undefined;
      }
      await deps.showStatus(ctx);
      return undefined;
    }
    if (refreshTermination(deps.config)) {
      try {
        await deps.applyTermination();
      } finally {
        if (ctx.chat && (ctx.callbackQuery || intent.kind !== 'event'))
          await replyTo(ctx, contextDestination(ctx), terminationMessage);
      }
      return undefined;
    }
    deps.clearTermination();
    const settingsPanel = deps.settingsReplyPanel(ctx);
    if (settingsPanel) {
      if (settingsPanel.capacityInput || settingsPanel.folderInput) await deps.saveSettingsReply(ctx, settingsPanel);
      return undefined;
    }
    if (ctx.inlineQuery) {
      await deps.skills.inline(ctx);
      return undefined;
    }
    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.data === undefined || !ctx.chat || !ctx.from || ctx.from.is_bot) return undefined;
      if (ctx.callbackQuery.data.startsWith('folder:')) {
        await deps.folderCallback(ctx,ctx.callbackQuery.data);
        return undefined;
      }
      if (ctx.callbackQuery.data.startsWith('skills:')) {
        const message = 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
        if (ctx.chat.type !== 'supergroup' || !deps.store.isEnrolled(deps.id, ctx.chat.id))
          return undefined;
        const destination = contextDestination(ctx);
        if (
          destination.kind === 'topic' &&
          deps.store.getTopicKind({
            botId: deps.id,
            chatId: destination.chatId,
            threadId: destination.threadId,
          }) === 'detached'
        )
          return undefined;
        const session = deps.store.getTopic({ botId: deps.id, destination });
        await deps.skills.callback(ctx, ctx.callbackQuery.data, session);
        return undefined;
      }
      if (ctx.callbackQuery.data.startsWith('preset:')) {
        await deps.presetCallback(ctx, ctx.callbackQuery.data);
        return undefined;
      }
      if (ctx.callbackQuery.data.startsWith('settings:')) {
        await deps.settingsCallback(ctx, ctx.callbackQuery.data);
        return undefined;
      }
      if (ctx.callbackQuery.data === 'setup:check') {
        const message = 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
        if (
          message &&
          'from' in message &&
          message.from?.id === deps.id &&
          !('forward_origin' in message) &&
          !('forward_date' in message)
        )
          await deps.setup(ctx);
      }
      const proposal = ctx.callbackQuery.data.match(/^prompt:approve:([A-Za-z0-9_-]{22})$/);
      if (proposal) await deps.approvePrompt(ctx, proposal[1]!);
      const capacity = ctx.callbackQuery.data.match(
        /^capacity:(approve|cancel):([A-Za-z0-9_-]{22})$/,
      );
      if (capacity) await deps.confirmCapacity(ctx, capacity[1]!, capacity[2]!);
      const answer = ctx.callbackQuery.data.match(/^ask:([A-Za-z0-9_-]{16}):(\d+|cancel)$/);
      if (answer) await deps.answerQuestion(ctx, answer[1]!, answer[2]!);
      return undefined;
    }
    if (ctx.myChatMember) {
      if (ctx.chat && ['administrator', 'member'].includes(ctx.myChatMember.new_chat_member.status))
        await replyTo(
          ctx,
          contextDestination(ctx),
          'A current group administrator can run /setup to request instance assignment from the local operator.',
        );
      return undefined;
    }
    const message = ctx.message;
    if (!message || !ctx.chat) return undefined;
    const topicLifecycle = intent.kind === 'event';
    const command =
      intent.kind === 'command' ? { action: intent.action, argument: intent.argument } : undefined;
    if (command?.action === 'terminate') {
      if (!(await deps.currentAdmin(ctx))) {
        await replyTo(
          ctx,
          contextDestination(ctx),
          'Termination requires a current group administrator.',
        );
        return undefined;
      }
      const member = await deps.bot.api.getChatMember(ctx.chat.id, ctx.from!.id);
      const persisted = readConfig(deps.config.configPath);
      const assigned = findInstance(persisted, deps.id, ctx.chat.id);
      if (
        !assigned ||
        assigned.instance.id !== deps.assignedId(ctx.chat.id) ||
        !isAdministrator(member)
      ) {
        await replyTo(
          ctx,
          contextDestination(ctx),
          'Termination requires a current group administrator.',
        );
        return undefined;
      }
      persisted.terminated = true;
      writeConfig(persisted);
      deps.config.terminated = true;
      try {
        await deps.applyTermination();
      } finally {
        await replyTo(ctx, contextDestination(ctx), terminationMessage);
      }
      return undefined;
    }
    if (ctx.chat.type === 'private') {
      await replyTo(
        ctx,
        contextDestination(ctx),
        `Add me to your own supergroup, enable Topics, grant Manage Topics and Pin Messages, then run /setup.${deps.config.publicUrl ? ' Configure the Mini App URL in BotFather for this bot.' : ''}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Add to Group',
                  url: `https://t.me/${deps.bot.botInfo!.username}?startgroup=setup&admin=manage_topics+pin_messages`,
                },
              ],
            ],
          },
        },
      );
      return undefined;
    }
    if (command?.action === 'setup') {
      await deps.setup(ctx);
      return undefined;
    }
    const assigned = findInstance(deps.config, deps.id, ctx.chat.id);
    if (!assigned || !deps.store.isEnrolled(deps.id, ctx.chat.id)) {
      if (command?.action === 'help') {
        await replyTo(
          ctx,
          contextDestination(ctx),
          deps.commandHelp(ctx.chat.id, await deps.currentAdmin(ctx)),
        );
      }
      return undefined;
    }
    if (command?.action === 'settings') {
      await deps.openSettings(ctx);
      return undefined;
    }
  return assigned;
}
