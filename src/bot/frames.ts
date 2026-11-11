import type { Bot, Context } from 'grammy';
import type { TopicSession, PromptContent } from '../../shared/contracts.js';
import type { HostFrame, CollabUiRequest, CustomMessageEntry } from '@oh-my-pi/pi-wire';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, SessionMetadataOwner, HostActivityObservation, TopicActivity } from './types.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { COLLAB_PROMPT_MESSAGE_TYPE } from '@oh-my-pi/pi-wire';
import { isStartupRejection } from '../collab.js';
import { miniAppInterruptionAuthor } from '../../shared/interruption.js';
import { sendTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { renderTelegramMarkdown } from '../telegram-markdown.js';

export interface FrameProjectionDependencies {
  acknowledgeMessage: (session: TopicSession, messageId: number, listener?: Listener) => void;
  activityObservation: (session: TopicSession) => HostActivityObservation;
  authorizeInitial: (session: TopicSession, userId: number, authorityUserId: number) => Promise<void>;
  background: AbortSignal;
  bot: Bot<Context>;
  delivery: TelegramDelivery;
  dropListener: (id: string, reason?: string) => void;
  getListener: (id: string) => Listener | undefined;
  currentMetadataOwner: (id: string) => SessionMetadataOwner | undefined;
  endRequestQuestions: (listener: Listener, reqId: number) => void;
  promptHelp: (chatId: number) => string;
  ready: (chatId: number) => Promise<boolean>;
  reconcilePromptReceipt: (session: TopicSession, listener: Listener, entry: CustomMessageEntry, replay: boolean, ompSessionId: string) => void;
  refreshTyping: (session: TopicSession, listener: Listener) => void;
  relayQuestion: (session: TopicSession, listener: Listener, request: CollabUiRequest) => void;
  sendPrompt: (listener: Listener, content: PromptContent, messageId?: number, onStartupRejected?: () => void) => void;
  sessionAssigned: (session: TopicSession) => boolean;
  sessionObservation: (id: string) => SessionObservation;
  setTopicStatus: (session: TopicSession, status: TopicActivity, completed?: boolean) => void | Promise<void>;
  stopped: () => boolean;
  syncTopicTitle: (session: TopicSession, listener: Listener, title?: string) => void;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'assistant' || !('content' in message) || !Array.isArray(message.content)) return undefined;
  const text = message.content.filter((part): part is {type:'text';text:string} => Boolean(part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')).map(part => part.text).join('\n');
  if (!text.trim()) return undefined;
  return text;
}
export class FrameProjection {
  constructor(private readonly deps: FrameProjectionDependencies) {}
  onFrame(
    session: TopicSession,
    listener: Listener,
    frame: HostFrame,
    replay = false,
  ): void {
    if (
      this.deps.stopped() ||
      this.deps.options.config.terminated ||
      !this.deps.sessionAssigned(session) ||
      this.deps.getListener(session.id) !== listener ||
      this.deps.options.store.getSessionGeneration(session.id) !== listener.generation
    )
      return;
    const ompSessionId = listener.ompSessionId;
    if (ompSessionId === undefined) throw new Error('OMP frame arrived before its session binding');
    if (!replay) listener.feed.accept(frame);
    if (frame.t === 'welcome') {
      listener.receiptBoundary = this.deps.options.store.beginPromptReceiptSnapshot(session.id, ompSessionId);
      listener.snapshotReplyTarget = this.deps.options.store.getReplyTarget(session.id);
    }
    this.deps.options.runtime.observeFrame(session.id, frame);
    if (
      frame.t === 'welcome' ||
      (frame.t === 'state' &&
        (!frame.state.isStreaming ||
          (frame.state.sessionName !== undefined &&
            frame.state.sessionName !== this.deps.currentMetadataOwner(session.id)?.title.humanTitle)))
    ) {
      this.deps.syncTopicTitle(session, listener, frame.state.sessionName);
    }
    if (frame.t === 'event' && frame.event.type === 'notice' && frame.event.level === 'error') {
      this.deps.sessionObservation(session.id).failure = {
        operation: 'OMP notice',
        at: Date.now(),
        error: frame.event.message,
      };
    }
    if (frame.t === 'ui-request') {
      this.deps.relayQuestion(session, listener, frame.request);
      return;
    }
    if (frame.t === 'ui-request-end') {
      const messageId = listener.pendingAnswers.get(frame.reqId);
      if (messageId !== undefined) {
        listener.pendingAnswers.delete(frame.reqId);
        this.deps.acknowledgeMessage(session, messageId, listener);
      }
      this.deps.endRequestQuestions(listener, frame.reqId);
      return;
    }
    if (
      frame.t === 'event' &&
      frame.event.type === 'notice' &&
      frame.event.level === 'info' &&
      frame.event.source === 'collab' &&
      frame.event.message === `Telegram @${this.deps.bot.botInfo!.username} interrupted`
    ) {
      listener.pendingAnswers.clear();
      const messageId = listener.pendingStops.shift();
      if (messageId !== undefined) this.deps.acknowledgeMessage(session, messageId, listener);
    }
    const interruptedBy = frame.t === 'event' ? miniAppInterruptionAuthor(frame.event) : undefined;
    if (interruptedBy) {
      listener.pendingAnswers.clear();
      listener.queuedMessages = 0;
      void this.deps.setTopicStatus(session, 'finished');
      void sendTo(
        this.deps.bot.api,
        topicDestination(session.chatId, session.threadId),
        `⛔️${interruptedBy} interrupted the chat`,
        {},
      ).catch(error => console.warn(`Could not deliver interruption notice (${session.id}).`, error));
    }
    if (frame.t === 'welcome' || frame.t === 'state') {
      listener.queuedMessages = frame.state.queuedMessageCount;
      void this.deps.setTopicStatus(
        session,
        this.deps.options.store.hasPendingInitialTask(session.id) ||
          frame.state.isStreaming ||
          listener.queuedMessages > 0
          ? 'running'
          : 'finished',
      );
    } else if (frame.t === 'event' && frame.event.type === 'agent_start') {
      void this.deps.setTopicStatus(session, 'running');
    } else if (frame.t === 'event' && frame.event.type === 'agent_end') {
      void this.deps.setTopicStatus(session, listener.queuedMessages > 0 ? 'running' : 'finished', true);
    }
    if (frame.t === 'event') {
      const event = frame.event;
      if (
        (event.type === 'message_start' || event.type === 'message_update') &&
        event.message.role === 'assistant'
      ) {
        listener.typingText = event.message.content.some(
          (part) => part.type === 'text' && part.text.length > 0,
        );
      } else if (
        event.type === 'message_end' ||
        event.type === 'agent_end' ||
        event.type === 'tool_execution_start' ||
        interruptedBy
      ) {
        listener.typingText = false;
      }
    } else if ((frame.t === 'welcome' || frame.t === 'state') && !frame.state.isStreaming) {
      listener.typingText = false;
    }
    this.deps.refreshTyping(session, listener);
    if (frame.t === 'error') {
      const observation = this.deps.activityObservation(session);
      observation.suspect = true;
      ++observation.revision;
      const pending = listener.pendingPrompts.shift();
      if (pending) {
        if (isStartupRejection(frame)) {
          this.deps.options.store.rejectPromptSubmission(pending.submissionId);
          pending.observation.state = 'not accepted';
        } else {
          this.deps.options.store.markPromptSubmissionUncertain(pending.submissionId);
          pending.observation.state = 'acceptance unknown';
        }
      }
      this.deps.sessionObservation(session.id).failure = {
        operation: 'OMP instruction',
        at: Date.now(),
        error: frame.message,
      };
      if (isStartupRejection(frame)) pending?.onStartupRejected?.();
    }
    if (isStartupRejection(frame) && listener.initial) {
      const initial = listener.initial;
      initial.phase = 'retrying';
      clearTimeout(initial.timer);
      const delay = Math.min(1000, 250 * ++initial.retries);
      if (Date.now() + delay >= initial.deadline) {
        listener.initial = undefined;
        void sendTo(
          this.deps.bot.api,
          topicDestination(session.chatId, session.threadId),
          `The host is still starting. The initial task was not admitted; send your task again after startup. ${this.deps.promptHelp(session.chatId)}`,
        ).catch(error => console.warn(`Could not deliver initial task startup timeout notice (${session.id}).`, error));
      } else {
        initial.timer = setTimeout(() => {
          void this.deps.authorizeInitial(session, initial.userId, initial.authorityUserId)
            .then(() => {
              if (
                listener.initial !== initial ||
                this.deps.stopped() ||
                !this.deps.sessionAssigned(session) ||
                !listener.connection
              )
                return;
              if (Date.now() >= initial.deadline) {
                listener.initial = undefined;
                return;
              }
              initial.timer = setTimeout(() => {
                listener.initial = undefined;
              }, initial.deadline - Date.now());
              initial.timer.unref();
              initial.phase = 'sent';
              this.deps.sendPrompt(listener, initial.content, initial.messageId);
            })
            .catch(error => {
              if (!this.deps.stopped() && error !== this.deps.background.reason)
                console.warn(`Could not retry initial task submission (${session.id}).`, error);
              clearTimeout(initial.timer);
              if (listener.initial === initial) listener.initial = undefined;
            });
        }, delay);
        initial.timer.unref();
      }
      return;
    }
    if (
      frame.t === 'entry' &&
      frame.entry.type === 'custom_message' &&
      frame.entry.customType === COLLAB_PROMPT_MESSAGE_TYPE
    )
      this.deps.reconcilePromptReceipt(session, listener, frame.entry, replay, ompSessionId);
    if (frame.t === 'error') {
      listener.pendingAnswers.clear();
      listener.pendingStops.length = 0;
      const prefix = isStartupRejection(frame)
        ? 'The host has not accepted this instruction during startup.\n\n'
        : 'OMP reported an error. Acceptance of a pending instruction is uncertain; inspect OPEN AGENT before submitting again.\n\n';
      void sendTo(
        this.deps.bot.api,
        topicDestination(session.chatId, session.threadId),
        prefix + frame.message,
        { entities: [{ type: 'pre', offset: prefix.length, length: frame.message.length }] },
      ).catch(error => console.warn(`Could not deliver OMP error notice (${session.id}).`, error));
      return;
    }
    if (frame.t === 'snapshot-chunk') {
      for (const entry of frame.entries) {
        if (
          listener.recovering ||
          (entry.type === 'custom_message' && entry.customType === COLLAB_PROMPT_MESSAGE_TYPE)
        )
          this.onFrame(session, listener, { t: 'entry', entry }, true);
        else if (entry.type === 'message') {
          const result = assistantText(entry.message);
          if (result) this.deps.options.store.rememberReply(session.id, ompSessionId, entry.id);
        }
      }
      if (frame.final) {
        this.deps.options.store.markSnapshot(session.id);
        this.deps.options.store.setReplyTarget(session.id, listener.snapshotReplyTarget);
      }
      return;
    }
    if (frame.t !== 'entry' || frame.entry.type !== 'message') return;
    const entry = frame.entry;
    const text = assistantText(entry.message);
    if (!text) return;
    const unseen = this.deps.options.store.rememberReply(session.id, ompSessionId, entry.id);
    if (!unseen) return;
    const replyTarget = replay
      ? listener.snapshotReplyTarget
      : this.deps.options.store.getReplyTarget(session.id);
    if (++listener.queued > 128) {
      this.deps.dropListener(session.id);
      return;
    }
    listener.tail = listener.tail
      .then(async () => {
        if (
          this.deps.stopped() ||
          !this.deps.sessionAssigned(session) ||
          this.deps.getListener(session.id) !== listener
        )
          return;
        const current = this.deps.options.store.getSession(session.id);
        if (
          !current ||
          current.status !== 'open' ||
          !(await this.deps.ready(session.chatId)) ||
          !this.deps.sessionAssigned(current)
        )
          return;
        let partIndex = 0;
        for (const part of renderTelegramMarkdown(text)) {
          if (!this.deps.sessionAssigned(current)) return;
          const sent = await this.deps.delivery.run(
            session.chatId,
            () =>
              this.deps.bot.api.sendRichMessage(
                session.chatId,
                { markdown: part },
                {
                  message_thread_id: session.threadId === 1 ? undefined : session.threadId,
                  ...(replyTarget === undefined
                    ? {}
                    : {
                        reply_parameters: {
                          message_id: replyTarget,
                          allow_sending_without_reply: true,
                        },
                      }),
                },
              ),
            () =>
              !this.deps.stopped() &&
              this.deps.sessionAssigned(current) &&
              this.deps.getListener(session.id) === listener,
          );
          if (!sent) return;
          this.deps.options.store.recordMessageAnchor(session.id, sent.chat.id, sent.message_id, {
            ompSessionId, entryId:entry.id, parentEntryId:entry.parentId,
            kind:'assistant', partIndex:partIndex++,
          });
        }
      })
      .catch(error => console.error(`Could not mirror OMP reply (${session.id}).`, error))
      .finally(() => {
        listener.queued--;
      });
  }
}
