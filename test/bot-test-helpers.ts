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

export function settingsButton(message: Record<string, unknown>, label: string | RegExp) {
  const markup = message.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
  const button = markup.inline_keyboard.flat().find(candidate =>
    typeof label === 'string' ? candidate.text === label : label.test(candidate.text));
  assert.ok(button?.callback_data, `Expected settings button ${String(label)}`);
  assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  return button.callback_data;
}

export async function clickSettings(app: SettingsApp, label: string | RegExp, message = app.messages.findLast(message =>
  (message.reply_markup as {inline_keyboard?: Array<Array<{callback_data?: string}>>} | undefined)?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('settings:')))!) {
  await app.callback(settingsButton(message, label), message);
  return message;
}

export async function setForumSetting(app: SettingsApp, page: string, choice: string | RegExp) {
  await app.update({ text: '/settings' });
  await clickSettings(app, page);
  await clickSettings(app, choice);
}
