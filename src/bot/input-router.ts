import type { Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { TopicDestination } from '../../shared/topic-destination.js';
import type { InputIntent } from '../telegram-input.js';
import { contextDestination } from '../telegram-destination.js';
import type { findInstance } from '../config.js';
import { routeEntry, type InputEntryDependencies } from './input-entry.js';
import { routeLifecycle, type InputLifecycleDependencies } from './input-lifecycle.js';
import { routePrompts, type InputPromptsDependencies } from './input-prompts.js';
import { inputCommandAccess, type InputCommandAccessDependencies } from './input-command-access.js';
import { inputCommandSessions, type InputCommandSessionsDependencies } from './input-command-sessions.js';
import { inputCommandPresets, type InputCommandPresetsDependencies } from './input-command-presets.js';
import { inputCommandControl, type InputCommandControlDependencies } from './input-command-control.js';

export type MessageContext = Context & {
  chat: NonNullable<Context['chat']>;
  message: NonNullable<Context['message']>;
};
export interface CommandRouteInput {
  ctx: MessageContext & { from: NonNullable<Context['from']> };
  session: TopicSession | undefined;
  destination: TopicDestination;
  detached: boolean;
  assigned: NonNullable<ReturnType<typeof findInstance>>;
  action: string;
  arg: string;
}

/** Keeps admission, lifecycle, prompt and command guards in their original order. */
export class InputRouter {
  constructor(
    private readonly entry: InputEntryDependencies,
    private readonly lifecycle: InputLifecycleDependencies,
    private readonly prompts: InputPromptsDependencies,
    private readonly access: InputCommandAccessDependencies,
    private readonly sessions: InputCommandSessionsDependencies,
    private readonly presets: InputCommandPresetsDependencies,
    private readonly control: InputCommandControlDependencies,
    private readonly requireSessionAssignment: (session: TopicSession) => void,
  ) {}

  async handle(ctx: Context, intent: InputIntent): Promise<void> {
    const assigned = await routeEntry(this.entry, ctx, intent);
    if (!assigned) return;
    // Entry admitted a group message. Keep the local narrowing across routing stages.
    const messageContext = ctx as MessageContext;
    const command = intent.kind === 'command'
      ? { action: intent.action, argument: intent.argument }
      : undefined;
    const destination = contextDestination(ctx);
    const session = this.entry.store.getTopic({ botId: this.entry.id, destination });
    const detached = destination.kind === 'topic' && this.entry.store.getTopicKind({
      botId: this.entry.id,
      chatId: destination.chatId,
      threadId: destination.threadId,
    }) === 'detached';
    if (session && !detached) this.requireSessionAssignment(session);
    if (await routeLifecycle(this.lifecycle, messageContext, intent, session, destination, detached)) return;
    if (await routePrompts(this.prompts, messageContext, intent, session, destination, detached, command)) return;
    if (!command) return;
    await this.prompts.authorize(ctx.chat!.id, ctx.from!.id);
    const input: CommandRouteInput = {
      ctx: messageContext as CommandRouteInput['ctx'],
      session, destination, detached, assigned,
      action: command.action, arg: command.argument,
    };
    if (await inputCommandAccess(this.access, input)) return;
    if (await inputCommandSessions(this.sessions, input)) return;
    if (await inputCommandPresets(this.presets, input)) return;
    await inputCommandControl(this.control, input);
  }
}
