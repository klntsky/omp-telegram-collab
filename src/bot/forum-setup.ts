import type { Context, Bot } from 'grammy';
import type { TopicSession, PromptContent, HostBinding } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import { contextDestination, replyTo, sendTo, forwardTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { defaultConfigPath, findInstance } from '../config.js';
import { isActiveMember } from '../auth.js';
export interface ForumSetupDependencies {
  options: BotOptions;
  bot: Bot<Context>;
  id: number;
  ready(chatId: number): Promise<boolean>;
  currentAdmin(ctx: Context): Promise<boolean>;
  assignedId(chatId: number): number;
  openSettings(ctx: Context): Promise<void>;
}

export class ForumSetup {
  constructor(private readonly dependencies: ForumSetupDependencies) {}
  localCliCommand(): string {
    const configPath = this.dependencies.options.config.configPath;
    return configPath === defaultConfigPath() ? 'omp-telegram-collab' : `omp-telegram-collab --config '${configPath.replaceAll("'", "'\\''")}'`;
  }
  async setup(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.from || ctx.from.is_bot || ctx.chat.type !== 'supergroup') return;
    const member = await this.dependencies.bot.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (!isActiveMember(member) || member.user.is_bot) return;
    if (!(await this.dependencies.ready(ctx.chat.id))) {
      await replyTo(ctx, contextDestination(ctx), 'Use a supergroup with Topics enabled, then grant this bot Manage Topics and Pin Messages permissions.', { reply_markup: { inline_keyboard: [[{text:'Check Again',callback_data:'setup:check'}]] } }); return;
    }
    const assigned = findInstance(this.dependencies.options.config, this.dependencies.id, ctx.chat.id);
    if (!assigned) {
      if (!(await this.dependencies.currentAdmin(ctx))) {
        const text = 'Only a current group administrator can request setup for an unassigned forum.';
        if (ctx.callbackQuery) await ctx.answerCallbackQuery(text);
        else await replyTo(ctx, contextDestination(ctx), text);
        return;
      }
      const request = this.dependencies.options.store.createSetupRequest({ botId: this.dependencies.id, chatId: ctx.chat.id, userId: member.user.id, ...(member.user.username ? { username: member.user.username.toLowerCase() } : {}), title: ctx.chat.title });
      const quotedInstancePath = "'" + process.cwd().replaceAll("'", "'\\''") + "'";
      const command = `${this.localCliCommand()} approve ${request.code} --path ${quotedInstancePath}`;
      const prefix = "Setup requested. On the agent's computer, approve within 10 minutes:\n";
      await replyTo(ctx, contextDestination(ctx), `${prefix}${command}\nThe project directory defaults to the bot's working directory. Change --path to the project directory where OMP should run. Leave the bot running and use a second terminal.`, { entities: [{ type: 'code', offset: prefix.length, length: command.length }] });
      return;
    }
    if (!(await this.dependencies.currentAdmin(ctx))) {
      const text = 'Only a current group owner or administrator can enroll this group.';
      if (ctx.callbackQuery) await ctx.answerCallbackQuery(text);
      else await replyTo(ctx, contextDestination(ctx), text);
      return;
    }
    this.dependencies.assignedId(ctx.chat.id);
    this.dependencies.options.store.enrollGroup(this.dependencies.id, ctx.chat.id);
    await this.dependencies.openSettings(ctx);
  }
}
