import { contextDestination, replyTo } from '../telegram-destination.js';
import type { TopicSession, HostBinding, CollabConnection } from '../../shared/contracts.js';
import type { Listener, TopicActivity } from './types.js';
import type { BotOptions } from '../bot.js';
import type { CommandRouteInput } from './input-router.js';



export interface InputCommandControlDependencies {
  acknowledgeMessage(session: TopicSession, messageId: number, listener?: Listener): void;
  authorize(chatId: number, userId: number, statusOnly?: boolean): Promise<void>;
  invalidateCapacity(sessionId: string): void;
  dropListener(id: string, reason?: string): void;
  invalidateActivity(id: string): void;
  listen(session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>, existingOnly?: boolean, recoverClosed?: boolean): Promise<CollabConnection>;
  listeners: Map<string, Listener>;
  runtime: BotOptions['runtime'];
  store: BotOptions['store'];
  requireSessionAssignment(session: TopicSession): void;
  invalidateSession(sessionId: string, reason?: string): void;
  setTopicStatus(session: TopicSession, activity: TopicActivity, suspect?: boolean): Promise<void>;
}

export async function inputCommandControl(deps: InputCommandControlDependencies, input: CommandRouteInput): Promise<boolean> {
  const { ctx, session, destination, detached, assigned, action, arg } = input;
  const message = ctx.message;
      if (action === 'stop' || action === 'kill') {
        if (destination.kind === 'general' || !session) {
          await replyTo(
            ctx,
            contextDestination(ctx),
            `Use /${action} inside a session topic, not General or an unrelated chat.`,
          );
          return true;
        }
        deps.requireSessionAssignment(session);
        if (action === 'stop' && session.status !== 'open') {
          await replyTo(
            ctx,
            contextDestination(ctx),
            'This session is archived. Reopen the topic before sending instructions.',
          );
          return true;
        }
        deps.store.cancelInitialTask(session.id);
        const listener = deps.listeners.get(session.id);
        clearTimeout(listener?.initial?.timer);
        if (listener) listener.initial = undefined;
        deps.invalidateActivity(session.id);
        deps.invalidateCapacity(session.id);
        if (action === 'kill') {
          deps.store.advanceSessionGeneration(session.id);
          deps.invalidateSession(session.id);
          deps.dropListener(session.id);
          await deps.runtime.kill(session);
          deps.acknowledgeMessage(session, message.message_id);
          await deps.setTopicStatus(session, 'finished');
          await replyTo(
            ctx,
            contextDestination(ctx),
            'Session process killed. History is preserved; a managed session can restart on your next instruction or OPEN AGENT visit.',
          );
          return true;
        }
        if (!(await deps.runtime.isRunning(session))) {
          deps.dropListener(session.id);
          await deps.setTopicStatus(session, 'finished');
          await replyTo(ctx, contextDestination(ctx), 'Session is not running.');
          return true;
        }
        const connection = await deps.listen(session);
        await deps.authorize(ctx.chat.id, ctx.from.id);
        deps.requireSessionAssignment(session);
        const activeListener = deps.listeners.get(session.id);
        if (
          !activeListener ||
          activeListener.connection !== connection ||
          activeListener.generation !== deps.store.getSessionGeneration(session.id)
        )
          throw new Error('Session closed');
        activeListener.pendingAnswers.clear();
        activeListener.pendingStops.push(message.message_id);
        try {
          connection.send({ t: 'abort' });
        } catch (error) {
          const index = activeListener.pendingStops.indexOf(message.message_id);
          if (index !== -1) activeListener.pendingStops.splice(index, 1);
          throw error;
        }
        await replyTo(
          ctx,
          contextDestination(ctx),
          'Abort requested. The session process is still running.',
        );
        return true;
      }
  return false;
}
