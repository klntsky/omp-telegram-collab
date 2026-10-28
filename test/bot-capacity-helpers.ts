import assert from 'node:assert/strict';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';

export function capacityRequest(app: {messages:Record<string, unknown>[]}, threadId?: number) {
  const message = app.messages.findLast(message => (threadId === undefined || message.message_thread_id === threadId) &&
    JSON.stringify(message.reply_markup)?.includes('capacity:approve:'));
  assert.ok(message,'a capacity confirmation must be sent in the waiting topic');
  const markup = message.reply_markup;
  assert.ok(markup && typeof markup === 'object' && 'inline_keyboard' in markup && Array.isArray(markup.inline_keyboard));
  const buttons = markup.inline_keyboard[0];
  assert.ok(Array.isArray(buttons) && typeof buttons[0]?.callback_data === 'string' && typeof buttons[1]?.callback_data === 'string');
  return {message,approve:String(buttons[0].callback_data),cancel:String(buttons[1].callback_data)};
}

export async function waitingForCapacity() {
  const app = await createSmokeApp({maxSessions:1});
  await app.update({text:'/setup'});
  await app.update({text:'/new Running task'});
  await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
  await app.update({text:'/new Waiting task'});
  return app;
}
