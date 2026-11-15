import { contextDestination, replyTo } from '../telegram-destination.js';
import type { Context } from 'grammy';
import type { TopicSession, HostBinding, CollabConnection, PromptContent } from '../../shared/contracts.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { BotOptions } from '../bot.js';
import type { CommandRouteInput } from './input-router.js';


export interface InputCommandSessionsDependencies {
  assignedCwd(chatId: number): string;
  assignedId(chatId: number): number;
  authorize(chatId: number, userId: number, statusOnly?: boolean): Promise<void>;
  commandHelp(chatId: number, admin: boolean): string;
  currentAdmin(ctx: Context): Promise<boolean>;
  dropListener(id: string, reason?: string): void;
  forkSession(ctx: Context, source: TopicSession): Promise<void>;
  listen(session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>, existingOnly?: boolean, recoverClosed?: boolean): Promise<CollabConnection>;
  newSession(ctx: Context, task?: PromptContent, attached?: { hostId: string; sessionId: string; instanceId: number; cwd: string; }, name?: string, accepted?: () => void, worktree?: boolean, authority?: Context, extensions?: readonly PromptExtension[], reservation?: { bind(id: string): void; }, cwd?: string, proposedSkills?: { names: string[]; topicSkills: string[]; }): Promise<void>;
  config: BotOptions['config'];
  runtime: BotOptions['runtime'];
  store: BotOptions['store'];
  requireSessionAssignment(session: TopicSession): void;
  routePrompt(ctx: Context, content: PromptContent, session?: TopicSession, extensions?: readonly PromptExtension[], worktree?: boolean, frozenSkills?: { names: string[]; topicSkills: string[]; }, cwd?: string): Promise<void>;
  sessionMarkup(session: TopicSession): { inline_keyboard: { text: string; url: string; }[][]; };
}

export async function inputCommandSessions(deps: InputCommandSessionsDependencies, input: CommandRouteInput): Promise<boolean> {
  const { ctx, session, destination, detached, assigned, action, arg } = input;
  const message = ctx.message;
      if (action === 'fork') {
        if (arg) throw new Error('Usage: /fork');
        if (!session || destination.kind !== 'topic' || session.runtime.kind !== 'managed' || session.status !== 'open')
          throw new Error('Use /fork inside an open managed session topic.');
        await deps.forkSession(ctx, session);
        return true;
      }
      if (action === 'worktree') {
        if (destination.kind === 'general') {
          await deps.routePrompt(ctx, { text: arg }, undefined, [], true);
          return true;
        }
        if (!session || detached) {
          await replyTo(
            ctx,
            destination,
            '🌳 Use /worktree inside an active session topic, or General to create one.',
          );
          return true;
        }
        if (!(await deps.currentAdmin(ctx))) {
          await replyTo(ctx, destination, '🌳 Worktree commands require a group administrator.');
          return true;
        }
        await deps.authorize(ctx.chat.id, ctx.from.id);
        deps.requireSessionAssignment(session);
        if (session.status !== 'open')
          throw new Error('This session is archived. Reopen the topic before creating a worktree.');
        let text: string;
        try {
          text = await deps.runtime.worktree(session, arg || undefined);
          deps.store.setSessionCwd(session.id, session.cwd);
        } finally {
          deps.dropListener(session.id);
        }
        await deps.listen(session);
        await replyTo(ctx, destination, `🌳 ${text}`);
        return true;
      }
      if (action === 'attach') {
        if (!(await deps.currentAdmin(ctx))) {
          await replyTo(ctx, contextDestination(ctx), 'Attaching requires a group administrator.');
          return true;
        }
        const match = arg.match(/^([A-Za-z0-9_-]+)(?:\s+(.+))?$/);
        if (!match) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'Usage: /attach instanceId [topic name]. Get the instance ID from omp collab list.',
          );
          return true;
        }
        const instanceId = deps.assignedId(ctx.chat.id);
        const cwd = deps.assignedCwd(ctx.chat.id);
        const binding = await deps.runtime.attach(match[1]!, cwd);
        await deps.newSession(
          ctx,
          undefined,
          { hostId: binding.instanceId, sessionId: binding.sessionId, instanceId, cwd },
          match[2] ?? 'Attached OMP session',
        );
        return true;
      }
      if (action === 'help' || action === 'start') {
        await replyTo(
          ctx,
          contextDestination(ctx),
          deps.commandHelp(ctx.chat.id, await deps.currentAdmin(ctx)),
          { parse_mode: 'HTML' },
        );
        return true;
      }
      if (action === 'cli') {
        if (!(await deps.currentAdmin(ctx))) {
          await replyTo(ctx, destination, 'This command requires a current group administrator.');
          return true;
        }
        if (arg) {
          await replyTo(ctx, destination, 'Usage: /cli');
          return true;
        }
        if (destination.kind !== 'topic' || !session) {
          await replyTo(ctx, destination, 'Use /cli in an active session topic.');
          return true;
        }
        deps.requireSessionAssignment(session);
        if (session.status !== 'open') { await replyTo(ctx, destination, 'This session is archived. Reopen the topic before joining.'); return true; }
        const command = `omp-telegram-collab session join --chat ${destination.chatId} --topic ${destination.threadId}`;
        await replyTo(ctx, destination, `Run this on the bot machine as the service OS account. If needed, supply --config with your operator configuration path. Copying the command does not grant access.\n<pre>${command}</pre>`, {
          parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'Copy command',copy_text:{text:command}}]]},
        });
        return true;
      }
      if (action === 'agent') {
        if (!deps.config.publicUrl) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'The Mini App is disabled. Continue using this topic to interact with the agent in Telegram.',
          );
          return true;
        }
        if (!session) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'No session in this topic. Use /new task or create a topic.',
          );
          return true;
        }
        await replyTo(ctx, contextDestination(ctx), `${session.name} (${session.status})`, {
          reply_markup: deps.sessionMarkup(session),
        });
        return true;
      }
  return false;
}
