import type { Bot, Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { HostFrame, CollabUiRequest, CustomMessageEntry, WireMessage } from '@oh-my-pi/pi-wire';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, SessionMetadataOwner, HostActivityObservation, TopicActivity } from './types.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { COLLAB_PROMPT_MESSAGE_TYPE } from '@oh-my-pi/pi-wire';
import { isStartupRejection } from '../collab.js';
import { miniAppInterruptionAuthor } from '../../shared/interruption.js';
import { sendTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { renderTelegramMarkdown } from '../telegram-markdown.js';
import { escapeHtml, preHtml } from '../telegram-html.js';

export interface FrameProjectionDependencies {
  acknowledgeMessage: (session: TopicSession, messageId: number, listener?: Listener) => void;
  activityObservation: (session: TopicSession) => HostActivityObservation;
  settlePrompt(session: TopicSession, submissionId: number, outcome: 'accepted' | 'startup-rejected' | 'uncertain'): void;
  background: AbortSignal;
  bot: Bot<Context>;
  delivery: TelegramDelivery;
  dropListener: (id: string, reason?: string) => void;
  getListener: (id: string) => Listener | undefined;
  currentMetadataOwner: (id: string) => SessionMetadataOwner | undefined;
  endRequestQuestions: (listener: Listener, reqId: number) => void;
  ready: (chatId: number) => Promise<boolean>;
  reconcilePromptReceipt: (session: TopicSession, listener: Listener, entry: CustomMessageEntry, replay: boolean, ompSessionId: string) => void;
  refreshTyping: (session: TopicSession, listener: Listener) => void;
  relayQuestion: (session: TopicSession, listener: Listener, request: CollabUiRequest) => void;
  sessionAssigned: (session: TopicSession) => boolean;
  sessionObservation: (id: string) => SessionObservation;
  setTopicStatus: (session: TopicSession, status: TopicActivity, completed?: boolean) => void | Promise<void>;
  stopped: () => boolean;
  syncTopicTitle: (session: TopicSession, listener: Listener, title?: string) => void;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
}

function assistantReply(message: WireMessage): string | undefined {
  if (message.role !== 'assistant') return undefined;
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (message.stopReason !== 'error') return text.trim() ? text : undefined;
  const diagnostic = message.errorMessage ?? 'The provider returned an error without a diagnostic.';
  const fence = '`'.repeat(Math.max(3, ...Array.from(diagnostic.matchAll(/`+/g), match => match[0].length + 1)));
  return `${text.trim() ? `${text}\n\n` : ''}OMP provider attempt failed (automatic recovery may follow).\n\n${fence}\n${diagnostic}\n${fence}`;
}
export class FrameProjection {
  private readonly pendingReplies = new WeakMap<Listener, Set<string>>();
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
    const activity = this.deps.activityObservation(session);
    if (frame.t === 'event') {
      const event = frame.event;
      if (event.type === 'auto_retry_start') activity.turnOutcome = 'retrying';
      if (event.type === 'auto_retry_end') activity.turnOutcome = event.success ? undefined : 'failed';
      if (event.type === 'message_end' && event.message.role === 'assistant' && activity.turnOutcome !== 'retrying')
        activity.turnOutcome = event.message.stopReason === 'error' ? 'failed' : undefined;
    }
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
        activity.turnOutcome === 'retrying' ||
          this.deps.options.store.promptQueue.has(session.id) ||
          frame.state.isStreaming ||
          listener.queuedMessages > 0
          ? 'running'
          : activity.turnOutcome === 'failed' ? 'unknown' : 'finished',
      );
    } else if (frame.t === 'event' && (frame.event.type === 'agent_start' || frame.event.type === 'auto_retry_start')) {
      void this.deps.setTopicStatus(session, 'running');
    } else if (frame.t === 'event' && (frame.event.type === 'agent_end' || frame.event.type === 'auto_retry_end')) {
      void this.deps.setTopicStatus(session, activity.turnOutcome === 'retrying' || listener.queuedMessages > 0 ? 'running' : activity.turnOutcome === 'failed' ? 'unknown' : 'finished', activity.turnOutcome !== 'failed');
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
          pending.observation.state = 'not accepted';
        } else {
          pending.observation.state = 'acceptance unknown';
        }
      }
      this.deps.sessionObservation(session.id).failure = {
        operation: 'OMP instruction',
        at: Date.now(),
        error: frame.message,
      };
      if (pending) this.deps.settlePrompt(session, pending.submissionId, isStartupRejection(frame) ? 'startup-rejected' : 'uncertain');
      if (pending && isStartupRejection(frame)) {
        console.warn('OMP startup rejected prompt.', frame.message, {sessionId: session.id, submissionId: pending.submissionId});
        listener.pendingAnswers.clear();
        listener.pendingStops.length = 0;
        return;
      }
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
        escapeHtml(prefix) + preHtml(frame.message),
        { parse_mode: 'HTML' },
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
          const result = assistantReply(entry.message);
          if (entry.message.role === 'assistant' && activity.turnOutcome !== 'retrying')
            activity.turnOutcome = entry.message.stopReason === 'error' ? 'failed' : undefined;
          if (result && !this.pendingReplies.get(listener)?.has(entry.id))
            this.deps.options.store.rememberReply(session.id, ompSessionId, entry.id);
        }
      }
      if (frame.final) {
        this.deps.options.store.markSnapshot(session.id);
        this.deps.options.store.setReplyTarget(session.id, listener.snapshotReplyTarget);
        if (activity.turnOutcome === 'failed' && activity.value === 'finished')
          void this.deps.setTopicStatus(session, 'unknown');
      }
      return;
    }
    if (frame.t !== 'entry' || frame.entry.type !== 'message') return;
    const entry = frame.entry;
    const text = assistantReply(entry.message);
    if (!text) return;
    if (entry.message.role === 'assistant' && entry.message.stopReason === 'error') {
      if (activity.turnOutcome !== 'retrying') activity.turnOutcome = 'failed';
      this.deps.sessionObservation(session.id).failure = {
        operation: 'OMP provider',
        at: Date.now(),
        error: entry.message.errorMessage,
      };
    } else if (entry.message.role === 'assistant' && activity.turnOutcome !== 'retrying') {
      activity.turnOutcome = undefined;
    }
    const pending = this.pendingReplies.get(listener) ?? new Set<string>();
    this.pendingReplies.set(listener, pending);
    if (pending.has(entry.id) || this.deps.options.store.hasReply(session.id, ompSessionId, entry.id)) return;
    if (entry.message.role === 'assistant' && entry.message.stopReason === 'error')
      console.error('OMP provider attempt failed.', {
        sessionId: session.id, ompSessionId, entryId: entry.id, model: entry.message.model,
      }, entry.message.errorMessage);
    const replyTarget = replay
      ? listener.snapshotReplyTarget
      : this.deps.options.store.getReplyTarget(session.id);
    if (++listener.queued > 128) {
      this.deps.dropListener(session.id);
      return;
    }
    pending.add(entry.id);
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
        const deliveredParts = this.deps.options.store.deliveredReplyParts(session.id, ompSessionId, entry.id);
        for (const part of renderTelegramMarkdown(text)) {
          if (!this.deps.sessionAssigned(current)) return;
          const index = partIndex++;
          if (deliveredParts.has(index)) continue;
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
            kind:'assistant', partIndex:index,
          });
        }
        this.deps.options.store.rememberReply(session.id, ompSessionId, entry.id);
      })
      .catch(error => console.error(`Could not mirror OMP reply (${session.id}).`, error))
      .finally(() => {
        listener.queued--;
        pending.delete(entry.id);
      });
  }
}
