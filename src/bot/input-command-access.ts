import { contextDestination, replyTo } from '../telegram-destination.js';
import type { Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { SkillPicker, SkillCatalogEntry } from '../skill-picker.js';
import type { BotOptions } from '../bot.js';
import type { CommandRouteInput } from './input-router.js';



export interface InputCommandAccessDependencies {
  currentAdmin(ctx: Context): Promise<boolean>;
  detachSession(session: TopicSession): Promise<void>;
  id: number;
  listAdmins(ctx: Context): Promise<void>;
  runtime: BotOptions['runtime'];
  store: BotOptions['store'];
  skillAliases: Map<number, Map<string, SkillCatalogEntry>>;
  skills: SkillPicker;
}

export async function inputCommandAccess(deps: InputCommandAccessDependencies, input: CommandRouteInput): Promise<boolean> {
  const { ctx, session, destination, detached, assigned, action, arg } = input;
  const message = ctx.message;
      if (action === 'list_admins') {
        if (arg) {
          await replyTo(ctx, destination, 'Usage: /list_admins');
          return true;
        }
        await deps.listAdmins(ctx);
        return true;
      }
      if (action === 'usage') {
        if (arg) {
          await replyTo(ctx, destination, 'Usage: /usage');
          return true;
        }
        const usage = await deps.runtime.providerUsage(assigned.instance.id);
        const text = usage
          .map(
            (section) => `${section.heading ? `**${section.heading}**\n\n` : ''}${section.table}`,
          )
          .join('\n\n');
        await ctx.api.sendRichMessage(
          destination.chatId,
          { markdown: text },
          {
            message_thread_id: destination.kind === 'topic' ? destination.threadId : undefined,
          },
        );
        return true;
      }
      const skillAlias = deps.skillAliases.get(ctx.chat.id)?.get(action);
      if (skillAlias) {
        if (detached) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'This topic is conversation-only. Select skills in General or a session topic.',
          );
          return true;
        }
        if (!arg) {
          await deps.skills.choose(ctx, skillAlias.name, session);
          return true;
        }
      }
      if (action === 'skills') {
        if (detached) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'This topic is conversation-only. Use /skills in General or a session topic.',
          );
          return true;
        }
        if (arg && arg !== 'clear') {
          await replyTo(ctx, contextDestination(ctx), 'Usage: /skills or /skills clear');
          return true;
        }
        await deps.skills.open(ctx, session, arg === 'clear');
        return true;
      }
      if (action === 'detach') {
        if (!(await deps.currentAdmin(ctx))) {
          await replyTo(ctx, contextDestination(ctx), 'Detaching requires a group administrator.');
          return true;
        }
        if (destination.kind !== 'topic') {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'Use /detach inside a topic, not General or an unrelated chat.',
          );
          return true;
        }
        deps.store.detachTopic({
          botId: deps.id,
          chatId: destination.chatId,
          threadId: destination.threadId,
        });
        if (session) await deps.detachSession(session);
        await replyTo(
          ctx,
          contextDestination(ctx),
          'This topic is now conversation-only. Session links, prompts, and mirroring are disabled. Host history is preserved; the host was not killed.',
        );
        return true;
      }
      if (detached && !['new', 'attach', 'help', 'start'].includes(action)) {
        await replyTo(
          ctx,
          contextDestination(ctx),
          'This topic is conversation-only. Use /new to create a separate session topic.',
        );
        return true;
      }
  return false;
}
