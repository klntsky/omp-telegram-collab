import assert from 'node:assert/strict';
import { InputMedia, type Message } from '@mtcute/node';
import { z } from 'zod';
import type { Store } from '../../../src/store.js';
import type { TelegramTestUser } from './telegram-user.js';
import type { TelegramTestBot, TelegramTestForum } from './telegram-resources.js';

export interface TelegramWorkflow {
  apiCalls: { method: string; payload: unknown; result: unknown }[];
  telegram: { bot: TelegramTestBot; forum: TelegramTestForum; user: TelegramTestUser };
  omp: { step<T>(name: string, action: () => Promise<T>): Promise<T> };
  store: Pick<Store, 'isEnrolled'>;
  send(text: string, threadId?: number): Promise<Message>;
  waitForCondition(predicate: () => boolean): Promise<void>;
}
export interface TelegramPanel {
  kind: '/settings' | '/skills';
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
    await app.send('/setup');
    await app.waitForCondition(() => app.store.isEnrolled(app.telegram.bot.id, app.telegram.forum.chatId));
  });
}

export async function openPanel(app: TelegramWorkflow, command: TelegramPanel['kind'], threadId?: number): Promise<TelegramPanel> {
  const start = app.apiCalls.length;
  await app.send(command, threadId);
  let panel: z.infer<typeof panelCall> | undefined;
  await app.waitForCondition(() => {
    for (const call of app.apiCalls.slice(start)) {
      const parsed = panelCall.safeParse(call);
      if (parsed.success && parsed.data.payload.reply_markup.inline_keyboard.flat().some(button =>
        button.callback_data?.startsWith(command === '/skills' ? 'skills:add:' : 'settings:'))) {
        panel = parsed.data;
        return true;
      }
    }
    return false;
  });
  assert.equal(panel!.payload.message_thread_id ?? 1, threadId ?? 1);
  return {
    kind: command,
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
