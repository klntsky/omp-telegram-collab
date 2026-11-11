import { contextDestination, replyTo } from '../telegram-destination.js';
import type { Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { PresetPanel } from './types.js';
import type { BotOptions } from '../bot.js';
import type { CommandRouteInput } from './input-router.js';
import { randomBytes } from 'node:crypto';



export interface InputCommandPresetsDependencies {
  authorize(chatId: number, userId: number, statusOnly?: boolean): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
  runtime: BotOptions['runtime'];
  store: BotOptions['store'];
  renderPresetPanel(panel: PresetPanel): Promise<void>;
  replyPresetText(ctx: Context, text: string): Promise<void>;
  replyPresetUsage(ctx: Context, instanceId: number, guidance?: string): Promise<void>;
  requireSessionAssignment(session: TopicSession): void;
}

export async function inputCommandPresets(deps: InputCommandPresetsDependencies, input: CommandRouteInput): Promise<boolean> {
  const { ctx, session, destination, detached, assigned, action, arg } = input;
  const message = ctx.message;
      if (action === 'modelpreset') {
        if (!(await deps.currentAdmin(ctx))) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'Model preset commands require a group administrator.',
          );
          return true;
        }
        if (destination.kind !== 'topic' || !session) {
          await deps.replyPresetUsage(
            ctx,
            assigned.instance.id,
            '\nUse this command in a session topic. Use /settings for forum defaults.',
          );
          return true;
        }
        if (session && session.status !== 'open') {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'This session is archived. Reopen the topic before using model preset commands.',
          );
          return true;
        }
        if (arg && !/^[A-Za-z][\w-]*$/.test(arg)) {
          await deps.replyPresetUsage(ctx, session.instanceId);
          return true;
        }
        if (!arg) {
          const panel: PresetPanel = {
            token: randomBytes(16).toString('base64url'), chatId: ctx.chat.id,
            destination, messageId: 0, instanceId: session.instanceId,
            sessionId: session.id, generation: deps.store.getSessionGeneration(session.id),
            revision: 0, expires: Date.now() + 30 * 60_000, choices: [], listOffset: 0, detailOffset: 0,
          };
          await deps.renderPresetPanel(panel);
          return true;
        }
        if (!session) return true;
        if (arg) {
          const names = await deps.runtime.availableModelPresets(session.instanceId, session.cwd);
          if (!names.includes(arg)) {
            await deps.replyPresetText(ctx, `Unknown model preset: ${arg}. Available presets: ${names.join(', ') || '(none)'}\nPlease refine your request with an available preset.`);
            return true;
          }
        }
        const generation = deps.store.getSessionGeneration(session.id);
        const release = deps.runtime.retain(session.id);
        try {
          await deps.runtime.ensure(session);
          await deps.authorize(ctx.chat.id, ctx.from.id);
          if (!(await deps.currentAdmin(ctx))) {
            await replyTo(
              ctx,
              contextDestination(ctx),
              'Model preset commands require a group administrator.',
            );
            return true;
          }
          deps.requireSessionAssignment(session);
          if (
            deps.store.getSessionGeneration(session.id) !== generation ||
            deps.store.getSession(session.id)?.status !== 'open'
          )
            throw new Error('The session changed before the model preset command could run');
          const text = await deps.runtime.modelPresets(session, arg);
          await deps.replyPresetText(ctx, text);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !==
              'OMP host is busy; wait for the current turn and queued messages to finish before switching model presets'
          )
            throw error;
          await replyTo(
            ctx,
            contextDestination(ctx),
            "Can't change model preset while busy. /stop first",
          );
        } finally {
          release();
        }
        return true;
      }
  return false;
}
