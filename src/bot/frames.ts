import { logEvent } from '../logging.js';
import type { Bot, Context } from 'grammy';
import type { TopicSession } from '../../shared/contracts.js';
import type { HostFrame, CollabUiRequest, CustomMessageEntry, SessionEntry } from '@oh-my-pi/pi-wire';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, SessionMetadataOwner, HostActivityObservation, TopicActivity } from './types.js';
import { COLLAB_PROMPT_MESSAGE_TYPE } from '@oh-my-pi/pi-wire';
import { isStartupRejection } from '../collab.js';
import { miniAppInterruptionAuthor } from '../../shared/interruption.js';
import { sendTo } from '../telegram-destination.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { escapeHtml, preHtml } from '../telegram-html.js';

export interface FrameProjectionDependencies {
  acknowledgeMessage: (session: TopicSession, messageId: number, listener?: Listener) => void;
  activityObservation: (session: TopicSession) => HostActivityObservation;
  settlePrompt(session: TopicSession, submissionId: number, outcome: 'accepted' | 'startup-rejected' | 'uncertain'): void;
  bot: Bot<Context>;
  getListener: (id: string) => Listener | undefined;
  currentMetadataOwner: (id: string) => SessionMetadataOwner | undefined;
  endRequestQuestions: (listener: Listener, reqId: number) => void;
  reconcilePromptReceipt: (session: TopicSession, listener: Listener, entry: CustomMessageEntry, replay: boolean, ompSessionId: string) => void;
  refreshTyping: (session: TopicSession, listener: Listener) => void;
  relayQuestion: (session: TopicSession, listener: Listener, request: CollabUiRequest) => void;
  sessionAssigned: (session: TopicSession) => boolean;
  sessionObservation: (id: string) => SessionObservation;
  setTopicStatus: (session: TopicSession, status: TopicActivity, completed?: boolean) => void | Promise<void>;
  stopped: () => boolean;
  syncTopicTitle: (session: TopicSession, listener: Listener, title?: string) => void;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
  queueReply(session: TopicSession, ompSessionId: string, entry: SessionEntry, replyTo?: number, historical?: boolean): void;
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
      ).catch(error => logEvent('warn', 'could-not-deliver-interruption-notice', {botId: session.botId, sessionId: session.id, chatId: session.chatId, threadId: session.threadId, message: `Could not deliver interruption notice (${session.id}).`, error}));
    }
    if (frame.t === 'welcome' || frame.t === 'state') {
      listener.queuedMessages = frame.state.queuedMessageCount;
      void this.deps.setTopicStatus(
        session,
        this.deps.options.store.promptQueue.has(session.id) ||
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
        logEvent('warn', 'omp-startup-rejected-prompt', {sessionId:session.id,submissionId:pending.submissionId,error:frame.message});
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
      ).catch(error => logEvent('warn', 'could-not-deliver-omp-error-notice', {botId:session.botId,sessionId:session.id,chatId:session.chatId,threadId:session.threadId,error}));
      return;
    }
    if (frame.t === 'snapshot-chunk') {
      for (const entry of frame.entries) {
        if (
          listener.recovering ||
          (entry.type === 'custom_message' && entry.customType === COLLAB_PROMPT_MESSAGE_TYPE)
        )
          this.onFrame(session, listener, { t: 'entry', entry }, true);
        else this.deps.queueReply(session, ompSessionId, entry, undefined, true);
      }
      if (frame.final) {
        this.deps.options.store.markSnapshot(session.id);
        this.deps.options.store.setReplyTarget(session.id, listener.snapshotReplyTarget);
      }
      return;
    }
    if (frame.t !== 'entry' || frame.entry.type !== 'message') return;
    this.deps.queueReply(session, ompSessionId, frame.entry,
      replay ? listener.snapshotReplyTarget : this.deps.options.store.getReplyTarget(session.id));
  }
}
