import type { Bot, Context } from 'grammy';
import type { TopicSession, HostBinding, CollabConnection, PromptContent } from '../../shared/contracts.js';
import type { CustomMessageEntry } from '@oh-my-pi/pi-wire';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, TaskObservation } from './types.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { isAdministrator } from '../auth.js';
import { AuthorizationDeniedError } from './types.js';
import type { PromptPreparation } from './prompt-preparation.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { SessionCapacityError } from '../runtime/types.js';

export interface PromptReceiptsDependencies {
  authorize: (chatId: number, userId: number) => Promise<void>;
  background: AbortSignal;
  bot: Bot<Context>;
  delivery: TelegramDelivery;
  getListener: (id: string) => Listener | undefined;
  listen: (session: TopicSession, binding?: HostBinding, beforeMutation?: () => Promise<void>, existingOnly?: boolean, recoverClosed?: boolean) => Promise<CollabConnection>;
  uploadDocuments: PromptPreparation['uploadDocuments'];
  prepareInitialDocuments: PromptPreparation['prepareInitialDocuments'];
  requestCapacity(session: TopicSession, limit: number): Promise<void>;
  requireSessionAssignment: (session: TopicSession) => void;
  sessionAssigned: (session: TopicSession) => boolean;
  sessionObservation: (id: string) => SessionObservation;
  stopped: () => boolean;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
}

export class PromptReceipts {
  private readonly preparing = new Map<string, Promise<void>>();
  constructor(private readonly deps: PromptReceiptsDependencies) {}
  sendPrompt(
    listener: Listener,
    content: PromptContent,
    messageId?: number,
    onStartupRejected?: () => void,
  ): void {
    const session = this.deps.options.store.getSession(listener.sessionId);
    if (!session) throw new Error('Session no longer exists');
    this.deps.requireSessionAssignment(session);
    if (session.status !== 'open')
      throw new Error('This topic is closed. Reopen it before submitting work.');
    if (
      this.deps.getListener(session.id) !== listener ||
      listener.generation !== this.deps.options.store.getSessionGeneration(session.id)
    )
      throw new Error('Session closed');
    if (listener.ompSessionId === undefined) throw new Error('OMP session is not connected');
    const submissionId = this.deps.options.store.recordPromptSubmission(
      session.id,
      listener.ompSessionId,
      `Telegram @${this.deps.bot.botInfo!.username}`,
      content,
      messageId,
    );
    const observation: TaskObservation = { state: 'waiting for acceptance', submissionId };
    this.deps.sessionObservation(session.id).task = observation;
    const pending = { submissionId, onStartupRejected, observation };
    listener.pendingPrompts.push(pending);
    let attempted = false;
    try {
      this.deps.options.runtime.markPrompt(listener.sessionId);
      attempted = true;
      listener.connection!.send({
        t: 'prompt',
        text: content.text,
        ...(content.images?.length ? { images: content.images } : {}),
      });
    } catch (error) {
      observation.state = attempted ? 'acceptance unknown' : 'not accepted';
      if (attempted) this.deps.options.store.markPromptSubmissionUncertain(submissionId);
      else this.deps.options.store.rejectPromptSubmission(submissionId);
      const index = listener.pendingPrompts.indexOf(pending);
      if (index !== -1) listener.pendingPrompts.splice(index, 1);
      throw error;
    }
  }
  async authorizeInitial(session: TopicSession, userId: number, authorityUserId: number): Promise<void> {
    try {
      await this.deps.authorize(session.chatId, userId);
      if (!isAdministrator(await this.deps.bot.api.getChatMember(session.chatId, authorityUserId))) {
        throw new AuthorizationDeniedError('Administrator access changed before initial task submission.');
      }
      this.deps.requireSessionAssignment(session);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) this.deps.options.store.cancelInitialTask(session.id);
      throw error;
    }
  }
  sendInitial(session: TopicSession): Promise<void> {
    const existing = this.preparing.get(session.id);
    if (existing) return existing;
    const pending = this.prepareInitial(session).finally(() => { this.preparing.delete(session.id); });
    this.preparing.set(session.id, pending);
    return pending;
  }
  private async prepareInitial(session: TopicSession): Promise<void> {
    this.deps.requireSessionAssignment(session);
    if (!this.deps.options.store.getPendingInitialTask(session.id)) return;
    const submittingUser = this.deps.options.store.getInitialUser(session.id);
    const approvingUser = this.deps.options.store.getInitialAuthority(session.id);
    if (submittingUser && approvingUser) {
      try {
        await this.deps.prepareInitialDocuments(session, () => this.authorizeInitial(session, submittingUser, approvingUser));
      } catch (error) {
        if (error instanceof SessionCapacityError) {
          try { await this.deps.requestCapacity(session, error.limit); }
          catch (deliveryError) { console.error('Could not deliver initial document preparation capacity request.', deliveryError); }
        }
        throw error;
      }
    }
    await this.deps.listen(session);
    const listener = this.deps.getListener(session.id);
    if (!listener) throw new Error('Session closed');
    if (this.deps.stopped()) throw this.deps.background.reason;
    if (!this.deps.options.store.hasPendingInitialTask(session.id)) return;
    const userId = this.deps.options.store.getInitialUser(session.id);
    const authorityUserId = this.deps.options.store.getInitialAuthority(session.id);
    if (!userId || !authorityUserId) {
      this.deps.options.store.cancelInitialTask(session.id);
      throw new Error('Initial task has no authorizing administrator. Submit the task again.');
    }
    await this.authorizeInitial(session, userId, authorityUserId);
    const pending = this.deps.options.store.getPendingInitialTask(session.id);
    if (!pending) return;
    if (pending.documents?.length) {
      const task = await this.deps.uploadDocuments(session, pending,
        () => this.authorizeInitial(session, userId, authorityUserId),
        topicDestination(session.chatId, session.threadId),
        remaining => this.deps.options.store.replacePendingInitialTask(session.id, remaining));
      this.deps.options.store.replacePendingInitialTask(session.id, task);
      await this.authorizeInitial(session, userId, authorityUserId);
    }
    if (this.deps.getListener(session.id) !== listener ||
        listener.generation !== this.deps.options.store.getSessionGeneration(session.id)) throw new Error('Session closed');
    this.deps.options.runtime.markPrompt(session.id);
    const task = this.deps.options.store.claimInitialTask(session.id);
    if (task === undefined) return;
    const messageId = this.deps.options.store.getInitialMessage(session.id);
    listener.initial = {content:task,userId,authorityUserId,messageId,deadline:Date.now()+this.deps.options.config.omp.startupTimeoutMs,retries:0,phase:'sent'};
    listener.initial.timer = setTimeout(() => { listener.initial = undefined; },this.deps.options.config.omp.startupTimeoutMs);
    listener.initial.timer.unref();
    this.sendPrompt(listener,task,messageId);
  }
  reconcilePromptReceipt(
    session: TopicSession,
    listener: Listener,
    entry: CustomMessageEntry,
    replay: boolean,
    ompSessionId: string,
  ): void {
    const text =
      typeof entry.content === 'string'
        ? entry.content
        : entry.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    const images =
      typeof entry.content === 'string'
        ? undefined
        : entry.content.filter((part) => part.type === 'image');
    const details = entry.details;
    const sender =
      details &&
      typeof details === 'object' &&
      'from' in details &&
      typeof details.from === 'string'
        ? details.from
        : undefined;
    const receipt = this.deps.options.store.recordPromptReceipt(
      session.id,
      {ompSessionId,entryId:entry.id,parentEntryId:entry.parentId},
      sender,
      { text, ...(images === undefined ? {} : { images }) },
      replay ? listener.receiptBoundary : undefined,
    );
    if (replay) listener.snapshotReplyTarget = receipt.messageId;
    else if (receipt.fresh) this.deps.options.store.setReplyTarget(session.id, receipt.messageId);
    if (!receipt.fresh) return;
    const index = listener.pendingPrompts.findIndex(
      (pending) => pending.submissionId === receipt.submissionId,
    );
    const pending = index === -1 ? undefined : listener.pendingPrompts.splice(index, 1)[0];
    const task = pending?.observation ?? this.deps.sessionObservation(session.id).task;
    if (receipt.submissionId !== undefined && task?.submissionId === receipt.submissionId)
      task.state = 'accepted; completion unknown';
    if (
      pending &&
      listener.initial?.phase === 'sent' &&
      listener.initial.messageId === receipt.messageId
    ) {
      clearTimeout(listener.initial.timer);
      listener.initial = undefined;
    }
    if (receipt.messageId !== undefined)
      this.acknowledgeMessage(session, receipt.messageId, listener);
  }
  acknowledgeMessage(session: TopicSession, messageId: number, listener?: Listener): void {
    void this.deps.delivery.run(session.chatId,
      () => this.deps.bot.api.setMessageReaction(session.chatId,messageId,[{type:'emoji',emoji:'🤝'}]),
      () => !this.deps.stopped() && this.deps.sessionAssigned(session) && (listener === undefined || this.deps.getListener(session.id) === listener))
      .catch(error => console.warn(`Could not show message acceptance reaction (${session.id}).`, error));
  }
}
