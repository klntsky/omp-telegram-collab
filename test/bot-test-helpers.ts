import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected state transition did not occur');
    await delay(20);
  }
}

interface SettingsApp {
  messages: Record<string, unknown>[];
  update(message: Record<string, unknown>): Promise<void>;
  callback(data: string, message: Record<string, unknown>): Promise<void>;
}

export function settingsButton(message: Record<string, unknown>, index: number) {
  const markup = message.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  return markup.inline_keyboard.flat().at(index)!.callback_data;
}

export async function clickSettings(app: SettingsApp, index: number, message = app.messages.findLast(message =>
  (message.reply_markup as {inline_keyboard?: Array<Array<{callback_data?: string}>>} | undefined)?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('settings:')))!) {
  await app.callback(settingsButton(message, index), message);
  return message;
}

export async function setForumSetting(app: SettingsApp, ...[page, choice]: [page: 0 | 1 | 5] | [page: 2 | 3, choice: number]) {
  await app.update({ text: '/settings' });
  await clickSettings(app, page);
  if (choice !== undefined) await clickSettings(app, choice);
}
