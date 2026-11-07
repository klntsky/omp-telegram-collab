import { contextDestination, replyTo } from '../telegram-destination.js';
import type { Bot, Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { InputIntent } from '../telegram-input.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import type { KnownTopicActivity, SessionMetadataOwner, SessionObservation, TopicTitleSource, TopicMetadata } from './types.js';
import type { BotOptions } from '../bot.js';
import type { MessageContext } from './input-router.js';
import type { TopicDestination } from '../../shared/topic-destination.js';
import { refreshTermination } from '../config.js';
import { opendirSync, accessSync, constants, realpathSync } from 'node:fs';



export interface InputLifecycleDependencies {
  readonly admissionEpoch: number;
  announce(session: TopicSession): Promise<void>;
  applySessionTitle(session: TopicSession): Promise<void>;
  assignedId(chatId: number): number;
  authorize(chatId: number, userId: number, statusOnly?: boolean): Promise<void>;
  bot: Bot<Context>;
  chooseFolder(source: Context, authority: Context | undefined, resume: (cwd: string, authority: Context) => Promise<void>, active?: () => boolean): Promise<boolean>;
  closedSessions: Map<string, { generation: number; settled: boolean; pending?: Promise<void>; }>;
  createTopicWorktree(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<void>;
  createsTopicWorktrees(chatId: number): boolean;
  currentAdmin(ctx: Context): Promise<boolean>;
  defaultNewTopicSkill(chatId: number): string | undefined;
  delivery: TelegramDelivery;
  dropListener(id: string, reason?: string): void;
  folderSettings(chatId: number): { instanceId: number; defaultDir: string; options: string[]; };
  getIconIds(): Promise<Record<KnownTopicActivity, string>>;
  readonly id: number;
  metadataOwners: Map<string, SessionMetadataOwner>;
  config: BotOptions['config'];
  store: BotOptions['store'];
  offerWorktreeCleanup(session: TopicSession, generation: number): Promise<void>;
  projectTopicTitle(session: TopicSession, title: string, active: () => boolean): Promise<void>;
  refreshTopicStatus(session: TopicSession): Promise<void>;
  runBackground(phase: string, operation: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void>;
  sessionAssigned(session: TopicSession): boolean;
  invalidateSession(sessionId: string, reason?: string): void;
  sessionObservation(id: string): SessionObservation;
  readonly stopped: boolean;
  stripTopicStatus(session: TopicSession, title: string): string;
  titleSource(session: TopicSession): TopicTitleSource;
  topicIconValue(session: TopicSession, ids: Record<KnownTopicActivity, string>): string | undefined;
  topicMetadata(session: TopicSession): TopicMetadata;
  windDownClosedSession(session: TopicSession): Promise<void>;
}

export async function routeLifecycle(deps: InputLifecycleDependencies, ctx: MessageContext, intent: InputIntent, session: TopicSession | undefined, destination: TopicDestination, detached: boolean): Promise<boolean> {
  const message = ctx.message;
  const topicLifecycle = intent.kind === 'event';
    if (detached && topicLifecycle) return true;
    if (message.forum_topic_created && destination.kind === 'topic') {
      if (!session) {
        if (deps.folderSettings(ctx.chat.id).options.length > 1) {
          await replyTo(ctx,destination,'Use /new with a task to choose a runtime folder before creating a managed session.');
          return true;
        }
        const title = message.forum_topic_created.name;
        const folderFingerprint = JSON.stringify(deps.folderSettings(ctx.chat.id));
        const epoch = deps.admissionEpoch;
        await deps.chooseFolder(ctx,undefined,async (cwd,authority) => {
          await deps.authorize(ctx.chat!.id,ctx.from!.id);
          if (authority.callbackQuery) {
            await deps.authorize(ctx.chat!.id,authority.from!.id);
            if (!(await deps.currentAdmin(authority))) throw new Error('Administrator access changed before manual session registration.');
          }
          if (epoch !== deps.admissionEpoch || deps.stopped || refreshTermination(deps.config) ||
              folderFingerprint !== JSON.stringify(deps.folderSettings(ctx.chat!.id)))
            throw new Error('Folder settings or service state changed before manual session registration.');
          opendirSync(cwd).closeSync();
          accessSync(cwd,constants.R_OK | constants.X_OK);
          if (realpathSync(cwd) !== cwd) throw new Error('Managed working directory identity changed');
          if (deps.store.getTopic({botId:deps.id,destination})) return;
          const created = deps.store.createSession(
            {
              botId: deps.id,
              chatId: destination.chatId,
              threadId: destination.threadId,
              instanceId: deps.assignedId(ctx.chat!.id), cwd,
            },
            title,
            {kind:'managed'},
          );
          const defaultSkill = deps.defaultNewTopicSkill(ctx.chat!.id);
          if (defaultSkill) deps.store.setNewTopicSkill(created.id, defaultSkill);
          if (deps.createsTopicWorktrees(ctx.chat!.id)) {
            await deps.authorize(ctx.chat!.id, authority.from!.id);
            if (!(await deps.currentAdmin(authority))) throw new Error('Administrator access changed before worktree creation.');
            await deps.createTopicWorktree(created);
          }
          await deps.announce(created);
          await deps.refreshTopicStatus(created);
        });
      }
      return true;
    }
    if (session && message.forum_topic_edited) {
      const edited = message.forum_topic_edited;
      const attributable = ctx.from !== undefined && !ctx.from.is_bot && !message.sender_chat;
      const metadata = deps.topicMetadata(session);
      if (attributable) {
        if (edited.name !== undefined) {
          const title = deps.stripTopicStatus(session, edited.name);
          const source = deps.titleSource(session);
          source.humanTitle = title;
          const prefix =
            [deps.store.getTopicTitlePrefix(session.id) ?? '', ...source.prefixes].find(
              (candidate) => candidate !== '' && edited.name?.startsWith(`${candidate} `),
            ) ?? '';
          deps.store.setTopicTitle(session.id, edited.name, prefix);
          deps.store.setPendingSessionTitle(session.id, title);
          const revision = ++source.revision;
          const generation = deps.store.getSessionGeneration(session.id);
          void deps.projectTopicTitle(
            session,
            title,
            () =>
              !deps.stopped &&
              !refreshTermination(deps.config) &&
              deps.sessionAssigned(session) &&
              deps.store.getSession(session.id)?.status === 'open' &&
              deps.store.getSessionGeneration(session.id) === generation &&
              source.revision === revision,
          );
          void metadata.name.observe(edited.name);
          void deps.applySessionTitle(session).catch((error) => {
            if (deps.stopped || deps.config.terminated || !deps.sessionAssigned(session)) return;
            console.warn(`Could not synchronize session title (${session.id}).`, error);
            deps.sessionObservation(session.id).failure = {
              operation: 'Topic title synchronization',
              at: Date.now(),
              error,
            };
          });
        }
        if (edited.icon_custom_emoji_id !== undefined) {
          const value = edited.icon_custom_emoji_id;
          void metadata.icon.publish(undefined);
          void deps.getIconIds()
            .then((ids) => {
              if (
                deps.stopped ||
                deps.config.terminated ||
                deps.metadataOwners.get(session.id)?.metadata !== metadata ||
                !deps.sessionAssigned(session) ||
                deps.store.getSessionGeneration(session.id) !== metadata.generation
              )
                return;
              if (value !== ids.running) deps.store.setTopicFinishIcon(session.id, value);
              const target = deps.topicIconValue(session, ids);
              if (target !== undefined) void metadata.icon.publish(target);
              void metadata.icon.observe(value);
            })
            .catch((error) => {
              if (!deps.stopped && !deps.config.terminated &&
                  deps.metadataOwners.get(session.id)?.metadata === metadata &&
                  deps.sessionAssigned(session) &&
                  deps.store.getSessionGeneration(session.id) === metadata.generation) {
                console.warn(`Could not synchronize topic icon (${session.id}).`, error);
                deps.sessionObservation(session.id).failure = {
                  operation: 'Topic icon synchronization',
                  at: Date.now(),
                  error,
                };
              }
            });
        }
      } else {
        if (edited.name !== undefined) void metadata.name.observe(edited.name);
        if (edited.icon_custom_emoji_id !== undefined)
          void metadata.icon.observe(edited.icon_custom_emoji_id);
      }
      if (
        ctx.from?.id === deps.id &&
        (edited.icon_custom_emoji_id !== undefined || edited.name !== undefined)
      ) {
        await deps.delivery
          .run(
            ctx.chat.id,
            () => deps.bot.api.deleteMessage(ctx.chat!.id, message.message_id),
            () => !deps.stopped && deps.sessionAssigned(session),
          )
          .catch((error) => {
            console.warn(
              `Could not delete topic edit notice (${session.id}, ${message.message_id}).`,
              error,
            );
          });
      }
      return true;
    }
    if (session && 'forum_topic_closed' in message) {
      if (deps.store.getSession(session.id)?.status !== 'closed') {
        deps.store.updateSession(session.id, { status: 'closed' });
        deps.store.advanceSessionGeneration(session.id);
      }
      deps.store.cancelInitialTask(session.id);
      deps.invalidateSession(session.id, 'This topic is closed. Reopen it explicitly to connect.');
      deps.dropListener(session.id);
      const generation = deps.store.getSessionGeneration(session.id);
      void deps.runBackground(`close:${session.id}`, async () => {
        await deps.windDownClosedSession(session);
        await deps.offerWorktreeCleanup(session, generation);
      });
      return true;
    }
    if (session && 'forum_topic_reopened' in message) {
      deps.store.updateSession(session.id, { status: 'open' });
      deps.closedSessions.delete(session.id);
      return true;
    }
  return false;
}
