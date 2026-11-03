import assert from 'node:assert/strict';
import { InputMedia, type Message } from '@mtcute/node';
import { z } from 'zod';
import type { Store } from '../../../src/store.js';
import type { OmpRuntime } from '../../../src/runtime.js';
import type { TopicSession } from '../../../shared/contracts.js';
import type { TelegramTestUser } from './telegram-user.js';
import type { TelegramTestBot, TelegramTestForum } from './telegram-resources.js';

export interface TelegramWorkflow {
  apiCalls: { method: string; payload: unknown; result: unknown }[];
  telegram: { bot: TelegramTestBot; forum: TelegramTestForum; user: TelegramTestUser };
  omp: { step<T>(name: string, action: () => Promise<T>): Promise<T> };
  store: Pick<Store, 'isEnrolled'>;
  send(text: string, threadId?: number): Promise<Message>;
  waitForCondition(predicate: () => boolean): Promise<void>;
  sendAndWait(text: string, threadId?: number): Promise<Message>;
  waitForMessageHandled(messageId: number): Promise<void>;
}
export interface TelegramPanel {
  kind: '/settings' | '/skills' | 'question' | 'folder';
  messageId: number;
  buttons: string[];
}

const replyMarkup = z.object({
  inline_keyboard: z.array(z.array(z.object({ callback_data: z.string().optional() }))),
});
const panelCall = z.object({
  method: z.literal('sendMessage'),
  payload: z.object({ message_thread_id: z.number().optional(), reply_markup: replyMarkup }),
  result: z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) }),
});

export async function enrollForum(app: TelegramWorkflow): Promise<void> {
  await app.omp.step('telegram.enroll', async () => {
    await app.sendAndWait('/setup');
    await app.waitForCondition(() => app.store.isEnrolled(app.telegram.bot.id, app.telegram.forum.chatId));
  });
}

export async function openPanel(app: TelegramWorkflow, command: '/settings' | '/skills', threadId?: number): Promise<TelegramPanel> {
  const start = app.apiCalls.length;
  await app.sendAndWait(command, threadId);
  return waitForPanel(app, command, command === '/skills' ? 'skills:add:' : 'settings:', start, threadId);
}

export async function waitForPanel(app: TelegramWorkflow, kind: TelegramPanel['kind'], prefix: string, start: number, threadId?: number): Promise<TelegramPanel> {
  let panel: z.infer<typeof panelCall> | undefined;
  await app.waitForCondition(() => {
    for (const call of app.apiCalls.slice(start)) {
      const parsed = panelCall.safeParse(call);
      if (parsed.success && parsed.data.payload.reply_markup.inline_keyboard.flat().some(button => button.callback_data?.startsWith(prefix))) {
        panel = parsed.data;
        return true;
      }
    }
    return false;
  });
  assert.equal(panel!.payload.message_thread_id ?? 1, threadId ?? 1);
  return {
    kind,
    messageId: panel!.result.result.message_id,
    buttons: panel!.payload.reply_markup.inline_keyboard.flat().flatMap(button => button.callback_data ? [button.callback_data] : []),
  };
}

export async function clickPanel(app: TelegramWorkflow, panel: TelegramPanel, index: number): Promise<void> {
  const start = app.apiCalls.length;
  const data = panel.buttons.at(index)!;
  await app.telegram.user.client.getCallbackAnswer({ chatId: app.telegram.forum.chat, message: panel.messageId, data });
  if (panel.kind !== '/settings' || index === -1) return;
  const editedPanel = z.object({ message_id: z.literal(panel.messageId), reply_markup: replyMarkup });
  await app.waitForCondition(() => {
    for (const call of app.apiCalls.slice(start)) {
      if (call.method !== 'editMessageText') continue;
      const parsed = editedPanel.safeParse(call.payload);
      if (parsed.success) {
        panel.buttons = parsed.data.reply_markup.inline_keyboard.flat().flatMap(button => button.callback_data ? [button.callback_data] : []);
        return true;
      }
    }
    return false;
  });
}

export function sendImageDocument(app: TelegramWorkflow, threadId: number, caption: string, base64: string) {
  const image = InputMedia.document(Buffer.from(base64, 'base64'), { fileName: 'e2e.png', fileMime: 'image/png' });
  return app.omp.step('telegram.user.send-image', () => app.telegram.user.client.sendMedia(
    app.telegram.forum.chat, image, { threadId, caption },
  ));
}

export async function replyText(app: TelegramWorkflow, messageId: number, threadId: number, text: string): Promise<Message> {
  const sent = await app.telegram.user.client.sendText(app.telegram.forum.chat, text, { replyTo: messageId, threadId });
  await app.waitForMessageHandled(sent.id);
  return sent;
}

export async function waitForEditor(app: TelegramWorkflow, start: number, threadId: number): Promise<number> {
  const editorCall = z.object({
    method: z.literal('sendMessage'),
    payload: z.object({ message_thread_id: z.literal(threadId), reply_markup: z.object({ force_reply: z.literal(true) }) }),
    result: z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) }),
  });
  let messageId: number | undefined;
  await app.waitForCondition(() => {
    for (const call of app.apiCalls.slice(start)) {
      const parsed = editorCall.safeParse(call);
      if (parsed.success) {
        messageId = parsed.data.result.result.message_id;
        return true;
      }
    }
    return false;
  });
  return messageId!;
}

interface LifecycleWorkflow extends TelegramWorkflow {
  store: Pick<Store, 'isEnrolled' | 'getSession' | 'hasPendingCloseIcon'>;
  runtime: Pick<OmpRuntime, 'isRunning'>;
}
const reactionCall = z.object({
  method: z.literal('setMessageReaction'),
  payload: z.object({
    chat_id: z.number(), message_id: z.number(),
    reaction: z.array(z.object({ type: z.literal('emoji'), emoji: z.string() })),
  }),
});

export function reactionAttempts(app: TelegramWorkflow, messageId: number): string[][] {
  return app.apiCalls.flatMap(call => {
    const parsed = reactionCall.safeParse(call);
    return parsed.success && parsed.data.payload.chat_id === app.telegram.forum.chatId &&
      parsed.data.payload.message_id === messageId
      ? [parsed.data.payload.reaction.map(reaction => reaction.emoji)] : [];
  });
}

export async function waitForReactionAttempt(app: TelegramWorkflow, messageId: number, emoji: string): Promise<void> {
  await app.waitForCondition(() => reactionAttempts(app, messageId).some(reactions => reactions.includes(emoji)));
}

export async function changeTopicClosed(app: TelegramWorkflow, threadId: number, closed: boolean): Promise<void> {
  const event = await app.telegram.user.client.toggleForumTopicClosed({
    chatId: app.telegram.forum.chat, topicId: threadId, closed,
  });
  await app.waitForMessageHandled(event.id);
}

export async function setTopicClosed(app: LifecycleWorkflow, session: TopicSession, closed: boolean): Promise<void> {
  await changeTopicClosed(app, session.threadId, closed);
  await app.waitForCondition(() => app.store.getSession(session.id)?.status === (closed ? 'closed' : 'open') &&
    (!closed || !app.store.hasPendingCloseIcon(session.id)));
  assert.equal(await app.runtime.isRunning(session), false);
}
