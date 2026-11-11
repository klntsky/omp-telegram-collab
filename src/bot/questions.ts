import { randomBytes } from 'node:crypto';
import type { Api, Context } from 'grammy';
import type { CollabUiRequest } from '@oh-my-pi/pi-wire';
import type { TopicSession } from '../../shared/contracts.js';
import { topicDestination } from '../../shared/topic-destination.js';
import { sendTo } from '../telegram-destination.js';
import type { TelegramDelivery } from '../telegram-delivery.js';
import type { Store } from '../store.js';
import type { Listener, PendingQuestion } from './types.js';

interface QuestionDependencies {
  api: Api;
  delivery: TelegramDelivery;
  store: Pick<Store, 'getSession' | 'getSessionGeneration'>;
  botId(): number;
  stopped(): boolean;
  listener(sessionId: string): Listener | undefined;
  sessionAssigned(session: TopicSession): boolean;
  requireSessionAssignment(session: TopicSession): void;
  authorize(chatId: number, userId: number): Promise<unknown>;
  dropListener(sessionId: string): void;
  ready(chatId: number): Promise<boolean>;
}

function optionMarker(index: number): string {
  const number = index+1;
  return number === 10 ? '🔟' : String(number).replace(/\d/g, digit => `${digit}\uFE0F\u20E3`);
}

export class BotQuestions {
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly endedQuestionReplies = new Map<string, {sessionId:string;generation:number} | undefined>();

  constructor(private readonly dependencies: QuestionDependencies) {}

  requestKind(token: string): CollabUiRequest['kind'] | undefined {
    return this.questions.get(token)?.request.kind;
  }

  findReplyToken(chatId: number, threadId: number | undefined, messageId: number): string | undefined {
    return [...this.questions.entries()].find(([,pending]) =>
      pending.session.chatId === chatId && pending.session.threadId === threadId &&
      pending.messageIds.includes(messageId))?.[0];
  }

  endedReply(key: string): {sessionId:string;generation:number} | undefined {
    return this.endedQuestionReplies.get(key);
  }

  hasEndedReply(key: string): boolean {
    return this.endedQuestionReplies.has(key);
  }

  endAll(): void {
    for (const token of this.questions.keys()) this.endQuestion(token);
  }

  endForListener(listener: Listener | undefined): void {
    for (const [token, question] of this.questions) {
      if (question.listener === listener) this.endQuestion(token);
    }
  }

  endForRequest(listener: Listener, reqId: CollabUiRequest['reqId']): void {
    for (const [token, question] of this.questions) {
      if (question.listener === listener && question.request.reqId === reqId) this.endQuestion(token);
    }
  }

  endQuestion(token: string): void {
    const question = this.questions.get(token);
    if (!question) return;
    this.questions.delete(token);
    for (const messageId of question.messageIds) {
      this.endedQuestionReplies.set(`${question.session.chatId}:${messageId}`,question.answer?.kind === 'discussion'
        ? {sessionId:question.session.id,generation:this.dependencies.store.getSessionGeneration(question.session.id)}
        : undefined);
    }
    while (this.endedQuestionReplies.size > 512) this.endedQuestionReplies.delete(this.endedQuestionReplies.keys().next().value!);
    const answer = question.answer?.text;
    const receiptId = answer === undefined ? undefined : question.buttonIds[0];
    for (const messageId of question.buttonIds) {
      if (messageId !== receiptId) {
        void this.dependencies.delivery.run(question.session.chatId,
          () => this.dependencies.api.editMessageReplyMarkup(question.session.chatId,messageId,{reply_markup:{inline_keyboard:[]}}),
          () => !this.dependencies.stopped() && this.dependencies.sessionAssigned(question.session))
          .catch(error => console.warn(`Could not retire question controls (${question.session.id}).`, error));
      }
    }
    // Serialize cleanup behind delivery so an invitation sent during completion is also removed.
    question.listener.tail = question.listener.tail.then(async () => {
      if (question.replyPromptId !== undefined) {
        await this.dependencies.delivery.run(question.session.chatId,
          () => this.dependencies.api.deleteMessage(question.session.chatId,question.replyPromptId!),
          () => !this.dependencies.stopped() && this.dependencies.sessionAssigned(question.session))
          .catch(error => console.warn(`Could not remove question reply invitation (${question.session.id}).`, error));
      }
      if (answer !== undefined) {
        for (let offset = 0; offset < answer.length;) {
          if (this.dependencies.stopped() || !this.dependencies.sessionAssigned(question.session)) return;
          let end = Math.min(offset+4000, answer.length);
          if (end < answer.length && answer.charCodeAt(end-1) >= 0xD800 && answer.charCodeAt(end-1) <= 0xDBFF) end--;
          const text = answer.slice(offset,end);
          if (offset === 0 && receiptId !== undefined) {
            await this.dependencies.delivery.run(question.session.chatId,
              () => this.dependencies.api.editMessageText(question.session.chatId,receiptId,text,{reply_markup:{inline_keyboard:[]}}),
              () => !this.dependencies.stopped() && this.dependencies.sessionAssigned(question.session));
          } else {
            await this.dependencies.delivery.run(question.session.chatId,
              () => sendTo(this.dependencies.api, topicDestination(question.session.chatId, question.session.threadId),text,{
                
                ...(receiptId === undefined ? {} : {reply_parameters:{message_id:receiptId,allow_sending_without_reply:true}}),
              }), () => !this.dependencies.stopped() && this.dependencies.sessionAssigned(question.session));
          }
          offset = end;
        }
      }
    }).catch(error => { console.warn(`Could not show question answer (${question.session.id}).`, error); });
  }
  submitAnswer(token: string, value?: string, receipt?: string, messageId?: number): void {
    const question = this.questions.get(token);
    if (!question || this.dependencies.stopped() || this.dependencies.listener(question.session.id) !== question.listener ||
        !this.dependencies.sessionAssigned(question.session) || this.dependencies.store.getSession(question.session.id)?.status !== 'open') return;
    this.dependencies.requireSessionAssignment(question.session);
    const discussion = question.request.kind === 'select' && value === 'Chat about this';
    question.answer = {kind:discussion ? 'discussion' : 'answer',text:discussion
      ? 'Chat about this selected. OMP will discuss the question. Reply to this message or the question to continue the discussion.'
      : receipt ?? (value === undefined ? 'Question cancelled.' : 'Custom answer sent.')};
    if (messageId !== undefined) question.listener.pendingAnswers.set(question.request.reqId,messageId);
    try {
      question.listener.connection!.send({t:'ui-response',reqId:question.request.reqId,value});
    } catch (error) {
      question.answer = undefined;
      question.listener.pendingAnswers.delete(question.request.reqId);
      throw error;
    }
    this.endQuestion(token);
  }
  async answerQuestion(ctx: Context, token: string, choice: string): Promise<void> {
    const question = this.questions.get(token);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!question || !message || !ctx.chat || !ctx.from || ctx.chat.type !== 'supergroup' ||
        ctx.chat.id !== question.session.chatId || !question.buttonIds.includes(message.message_id) ||
        !('message_thread_id' in message) || message.message_thread_id !== question.session.threadId ||
        !('from' in message) || message.from?.id !== this.dependencies.botId() || 'forward_origin' in message || 'forward_date' in message) {
      await ctx.answerCallbackQuery('This question is no longer active.');
      return;
    }
    await this.dependencies.delivery.run(ctx.chat.id, () => this.dependencies.authorize(ctx.chat!.id,ctx.from!.id),
      () => !this.dependencies.stopped() && this.questions.get(token) === question);
    if (choice === 'cancel') this.submitAnswer(token);
    else if (question.request.kind === 'select') {
      const option = question.request.options[Number(choice)];
      if (option === undefined) return;
      await this.dependencies.delivery.run(question.session.chatId,
        () => this.dependencies.api.setMessageReaction(question.session.chatId,message.message_id,[{type:'emoji',emoji:'👀'}]),
        () => !this.dependencies.stopped() && this.dependencies.sessionAssigned(question.session) &&
          this.dependencies.listener(question.session.id) === question.listener && this.questions.get(token) === question)
        .catch(error => { console.warn(`Could not show question selection receipt (${question.session.id}).`, error); });
      const value = typeof option === 'string' ? option : option.label;
      this.submitAnswer(token, value, `Selected ${optionMarker(Number(choice))}: ${value}`, message.message_id);
    }
    await ctx.answerCallbackQuery();
  }
  relayQuestion(session: TopicSession, listener: Listener, request: CollabUiRequest): void {
    if (listener.pendingAnswers.has(request.reqId) ||
        [...this.questions.values()].some(question => question.listener === listener && question.request.reqId === request.reqId)) return;
    const token = randomBytes(12).toString('base64url');
    const question: PendingQuestion = {session, listener, request, messageIds:[],buttonIds:[]};
    this.questions.set(token, question);
    if (++listener.queued > 128) { this.dependencies.dropListener(session.id); return; }
    listener.tail = listener.tail.then(async () => {
      const active = () => this.questions.get(token) === question && !this.dependencies.stopped() &&
        this.dependencies.listener(session.id) === listener && this.dependencies.sessionAssigned(session) &&
        this.dependencies.store.getSession(session.id)?.status === 'open';
      if (!active() || !(await this.dependencies.ready(session.chatId))) { this.endQuestion(token); return; }
      const parts = [request.title];
      if (request.kind === 'select') {
        parts.push(...request.options.map((option, index) => {
          const label = typeof option === 'string' ? option : option.label;
          const marker = request.checkedIndices?.includes(index) ? '[x] ' : '';
          return `${optionMarker(index)} ${marker}${label}${typeof option !== 'string' && option.description ? `\n${option.description}` : ''}`;
        }));
        if (request.helpText) parts.push(request.helpText);
      } else if (request.prefill) parts.push(request.prefill);
      const body = parts.join('\n\n');
      for (let offset = 0; offset < body.length;) {
        if (!active()) return;
        let end = Math.min(offset+4000, body.length);
        if (end < body.length && body.charCodeAt(end-1) >= 0xD800 && body.charCodeAt(end-1) <= 0xDBFF) end--;
        const message = await this.dependencies.delivery.run(session.chatId,
          () => sendTo(this.dependencies.api, topicDestination(session.chatId, session.threadId),body.slice(offset,end)),active);
        if (!message) return;
        question.messageIds.push(message.message_id);
        offset = end;
      }
      const buttons = request.kind === 'select' ? request.options.map((_, index) =>
        ({text:optionMarker(index),callback_data:`ask:${token}:${index}`})) : [];
      for (let offset = 0; offset < Math.max(1,buttons.length); offset += 80) {
        if (!active()) return;
        const keyboard: {text:string;callback_data:string}[][] = [];
        for (let index = offset; index < Math.min(offset+80,buttons.length); index += 5) {
          keyboard.push(buttons.slice(index,Math.min(index+5,offset+80)));
        }
        if (offset+80 >= buttons.length) keyboard.push([{text:'Cancel',callback_data:`ask:${token}:cancel`}]);
        const message = await this.dependencies.delivery.run(session.chatId,
          () => sendTo(this.dependencies.api, topicDestination(session.chatId, session.threadId),
            request.kind === 'editor' ? 'You can type a custom answer below, or cancel here.' : 'Choose an answer by number:', {
              
              reply_markup:{inline_keyboard:keyboard},
            }), active);
        if (!message) return;
        question.messageIds.push(message.message_id);
        question.buttonIds.push(message.message_id);
        if (!active()) {
          void this.dependencies.delivery.run(session.chatId,
            () => this.dependencies.api.editMessageReplyMarkup(session.chatId,message.message_id,{reply_markup:{inline_keyboard:[]}}),
            () => !this.dependencies.stopped() && this.dependencies.sessionAssigned(session))
            .catch(error => console.warn(`Could not retire inactive question controls (${session.id}).`, error));
        }
      }
      if (request.kind === 'editor' && active()) {
        const message = await this.dependencies.delivery.run(session.chatId,
          () => sendTo(this.dependencies.api, topicDestination(session.chatId, session.threadId),'Reply here with your answer. Multiline text is supported.',{
            
            reply_markup:{force_reply:true,input_field_placeholder:'Type your custom answer'},
          }), active);
        if (!message) return;
        question.messageIds.push(message.message_id);
        question.replyPromptId = message.message_id;
      }
    }).catch(error => {
      this.endQuestion(token);
      console.warn(`Could not relay agent question (${session.id}).`, error);
    }).finally(() => { listener.queued--; });
  }
}
