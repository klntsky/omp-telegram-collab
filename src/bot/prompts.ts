import type { Bot, Context } from 'grammy';
import type { TopicSession, PromptContent } from '../../shared/contracts.js';
import type { CustomMessageEntry } from '@oh-my-pi/pi-wire';
import type { BotOptions } from '../bot.js';
import type { Listener, SessionObservation, TaskObservation } from './types.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import { isAdministrator } from '../auth.js';
import { AuthorizationDeniedError } from './types.js';

export interface PromptReceiptsDependencies {
  authorize: (chatId: number, userId: number) => Promise<void>;
  bot: Bot<Context>;
  delivery: TelegramDelivery;
  getListener: (id: string) => Listener | undefined;
  requireSessionAssignment: (session: TopicSession) => void;
  sessionAssigned: (session: TopicSession) => boolean;
  sessionObservation: (id: string) => SessionObservation;
  stopped: () => boolean;
  options: Pick<BotOptions, 'config' | 'runtime' | 'store'>;
  settlePrompt(session: TopicSession, submissionId: number, outcome: 'accepted' | 'startup-rejected' | 'uncertain'): void;
}

export class PromptReceipts {
  constructor(private readonly deps: PromptReceiptsDependencies) {}
  async prepareContent(session: TopicSession, content: PromptContent): Promise<PromptContent> {
    if (this.deps.options.store.hasPromptHistory(session.id)) return content;
    const chat = await this.deps.bot.api.getChat(session.chatId);
    if (chat.type !== 'supergroup') throw new Error('Agent session requires a Telegram supergroup');
    return {
      ...content,
      text: `<preamble>
This agent session (a.k.a. conversation) is running via omp-telegram-collab: a tool that provides a Telegram <-> OMP.sh bridge.

You (the assistant) should acknowledge this fact whenever it is relevant.

Agent's responses are sent to the user via Telegram, and the user can send messages to OMP by replying in a telegram chat.

Agent sessions are tied to a telegram topic in a chat titled "${chat.title}". The link to this session's topic is: https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}

omp-telegram-collab wraps OMP from the outside, so it does not require any changes in the way the agent communicates with the harness.

This preamble will be sent to you once. It is relevant only within the context of this conversation. It does not need your response or acknowledgment now.
</preamble>

${content.text}`,
    };
  }
  sendPrompt(
    listener: Listener,
    content: PromptContent,
    messageId?: number,
    beforeSend?: (submissionId: number) => void,
  ): number {
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
    this.deps.options.runtime.markPrompt(listener.sessionId);
    const store = this.deps.options.store;
    let submissionId: number;
    store.db.exec('BEGIN IMMEDIATE');
    try {
      submissionId = store.recordPromptSubmission(
        session.id, listener.ompSessionId, `Telegram @${this.deps.bot.botInfo!.username}`, content, messageId,
      );
      beforeSend?.(submissionId);
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
    const observation: TaskObservation = { state: 'waiting for acceptance', submissionId };
    this.deps.sessionObservation(session.id).task = observation;
    const pending = { submissionId, observation };
    listener.pendingPrompts.push(pending);
    try {
      listener.connection!.send({
        t: 'prompt',
        text: content.text,
        ...(content.images?.length ? { images: content.images } : {}),
      });
    } catch (error) {
      observation.state = 'acceptance unknown';
      this.deps.options.store.markPromptSubmissionUncertain(submissionId);
      const index = listener.pendingPrompts.indexOf(pending);
      if (index !== -1) listener.pendingPrompts.splice(index, 1);
      this.deps.settlePrompt(session, submissionId, 'uncertain');
      throw error;
    }
    return submissionId;
  }
  async authorizePrompt(session: TopicSession, userId: number, authorityUserId: number): Promise<void> {
    await this.deps.authorize(session.chatId, userId);
    if (!isAdministrator(await this.deps.bot.api.getChatMember(session.chatId, authorityUserId))) {
      throw new AuthorizationDeniedError('Administrator access changed before prompt submission.');
    }
    this.deps.requireSessionAssignment(session);
  }
  recordReceipt(session: TopicSession, entry: CustomMessageEntry, ompSessionId: string, boundary?: number) {
    const text = typeof entry.content === 'string' ? entry.content :
      entry.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const images = typeof entry.content === 'string' ? undefined :
      entry.content.filter(part => part.type === 'image');
    const details = entry.details;
    const sender = details && typeof details === 'object' && 'from' in details &&
      typeof details.from === 'string' ? details.from : undefined;
    const receipt = this.deps.options.store.recordPromptReceipt(session.id,
      {ompSessionId,entryId:entry.id,parentEntryId:entry.parentId}, sender,
      {text,...(images === undefined ? {} : {images})}, boundary);
    if (!receipt.fresh) return receipt;
    const current = this.deps.getListener(session.id);
    const listener = current?.ompSessionId === ompSessionId ? current : undefined;
    const index = listener?.pendingPrompts.findIndex(
      pending => pending.submissionId === receipt.submissionId,
    ) ?? -1;
    const pending = index === -1 ? undefined : listener!.pendingPrompts.splice(index, 1)[0];
    const task = pending?.observation ?? this.deps.sessionObservation(session.id).task;
    if (receipt.submissionId !== undefined && task?.submissionId === receipt.submissionId)
      task.state = 'accepted; completion unknown';
    if (receipt.submissionId !== undefined)
      this.deps.settlePrompt(session, receipt.submissionId, 'accepted');
    if (receipt.messageId !== undefined)
      this.acknowledgeMessage(session, receipt.messageId, listener);
    return receipt;
  }
  reconcilePromptReceipt(
    session: TopicSession,
    listener: Listener,
    entry: CustomMessageEntry,
    replay: boolean,
    ompSessionId: string,
  ): void {
    const receipt = this.recordReceipt(session, entry, ompSessionId,
      replay ? listener.receiptBoundary : undefined);
    // Offline recovery may have ingested this receipt first. Live frame order still
    // owns the current reply target even when the receipt's bookkeeping is idempotent.
    if (replay) listener.snapshotReplyTarget = receipt.messageId;
    else this.deps.options.store.setReplyTarget(session.id, receipt.messageId);
  }
  acknowledgeMessage(session: TopicSession, messageId: number, listener?: Listener): void {
    void this.deps.delivery.run(session.chatId,
      () => this.deps.bot.api.setMessageReaction(session.chatId,messageId,[{type:'emoji',emoji:'🤝'}]),
      () => !this.deps.stopped() && this.deps.sessionAssigned(session) && (listener === undefined || this.deps.getListener(session.id) === listener))
      .catch(error => console.warn(`Could not show message acceptance reaction (${session.id}).`, error));
  }
}
