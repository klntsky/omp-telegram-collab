import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'grammy';
import type { GuestFrame } from '@oh-my-pi/pi-wire';
import type { Store } from '../src/store.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually, setForumSetting } from './bot-test-helpers.js';

type User = NonNullable<Context['from']>;
interface App {
  accepted: GuestFrame[];
  messages: Record<string, unknown>[];
  store: Store;
  update(message: Record<string, unknown>, from?: User): Promise<void>;
  callback(data: string, message: Record<string, unknown>, from?: User): Promise<void>;
}
type Button = { text: string; callback_data?: string; switch_inline_query_current_chat?: string };
const participant: User = { id: ownerId + 5, first_name: 'Grace', username: 'grace', is_bot: false };

function buttons(message: Record<string, unknown>): Button[] {
  return (message.reply_markup as { inline_keyboard: Button[][] } | undefined)?.inline_keyboard.flat() ?? [];
}
function prompts(app: App) { return app.accepted.filter(frame => frame.t === 'prompt'); }
async function select(app: App, name: string, threadId?: number, user?: User) {
  await app.update({ text: '/skills', ...(threadId === undefined ? {} : { message_thread_id: threadId }) }, user);
  const picker = app.messages.at(-1)!;
  const index = ['find-skills', 'pdf-tools'].indexOf(name);
  const button = buttons(picker).find(value => value.callback_data?.startsWith('skills:add:') && value.callback_data.endsWith(`:${index}`));
  assert.ok(button?.callback_data, `picker must have a normal callback button for ${name}`);
  await app.callback(button.callback_data, picker, user);
  return { picker, data: button.callback_data };
}
async function seed(app: App) {
  await app.update({ text: '/setup' });
  await app.update({ text: '/new Seed' });
  await eventually(() => prompts(app).length === 1);
  return app.store.listSessions(botId)[0]!;
}

test('pending skills stay isolated by user and topic', async () => {
  const app = await createSmokeApp();
  try {
    const session = await seed(app);
    await select(app, 'pdf-tools', session.threadId);
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Other topic' } });
    await app.update({ text: '/p Other topic', message_thread_id: 42 });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: 'Other topic' });
    app.setCurrentMember({ username: ownerUsername, status: 'creator' });
    app.setUserRole(participant,'administrator');
    await app.update({ text: '/p Other user', message_thread_id: session.threadId }, { ...participant, username: ownerUsername });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: 'Other user' });
    await app.update({ text: '/p Original user', message_thread_id: session.threadId });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: '/skill:pdf-tools\n\nOriginal user' });
  } finally { await app.close(); }
});


test('skill composition preserves normalized caption, reply quote and downloaded image', async t => {
  const app = await createSmokeApp();
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  app.mockFiles(t, imageData);
  try {
    const session = await seed(app);
    await select(app, 'pdf-tools', session.threadId);
    await app.update({
      message_thread_id: session.threadId,
      photo: [{ file_id: 'photo', file_unique_id: 'photo', width: 100, height: 100 }],
      caption: '/p@FixtureOmpBot Explain this',
      reply_to_message: { message_id: 9000, caption: 'Original\ncontext' },
    });
    assert.deepEqual(prompts(app).at(-1), {
      t: 'prompt', text: '/skill:pdf-tools\n\n> Original\n> context\n\nExplain this',
      images: [{ type: 'image', data: imageData, mimeType: 'image/jpeg' }],
    });
  } finally { await app.close(); }
});

test('ignored commands, discussion and rejected prompts retain skills; clear removes them', async () => {
  const app = await createSmokeApp();
  try {
    const session = await seed(app);
    await app.update({ text: '/setup' });
    await setForumSetting(app, 0);
    await select(app, 'find-skills', session.threadId);
    await app.update({ text: '/unknown', message_thread_id: session.threadId });
    await app.update({ text: 'Discussion', message_thread_id: session.threadId });
    await app.update({ text: '/p', message_thread_id: session.threadId });
    await app.update({ text: '/p@AnotherBot Ignore', message_thread_id: session.threadId });
    app.rejectNextPrompt();
    await app.update({ text: '/p Rejected', message_thread_id: session.threadId });
    assert.equal(prompts(app).length, 1);
    await app.update({ text: '/p Accepted', message_thread_id: session.threadId });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: '/skill:find-skills\n\nAccepted' });
    await select(app, 'pdf-tools', session.threadId);
    await app.update({ text: '/skills clear', message_thread_id: session.threadId });
    await app.update({ text: '/p After clear', message_thread_id: session.threadId });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: 'After clear' });
  } finally { await app.close(); }
});

test('proposal creation freezes and consumes proposer skills without consuming a later selection', async () => {
  const app = await createSmokeApp();
  try {
    const session = await seed(app);
    await app.update({ text: '/setup' });
    await setForumSetting(app, 1);
    app.setCurrentMember({ username: 'grace', status: 'member' });
    await select(app, 'find-skills', session.threadId, participant);
    await app.update({ text: '/p Frozen proposal', message_thread_id: session.threadId }, participant);
    const proposal = app.messages.at(-1)!;
    const approve = buttons(proposal).find(button => button.callback_data?.startsWith('prompt:approve:'));
    assert.ok(approve?.callback_data);
    assert.equal(prompts(app).length, 1);
    await select(app, 'pdf-tools', session.threadId, participant);
    app.setCurrentMember({ username: ownerUsername, status: 'creator' });
    await app.callback(approve.callback_data, proposal);
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: '/skill:find-skills\n\nFrozen proposal' });
    app.setCurrentMember({ username: 'grace', status: 'member' });
    await app.update({ text: '/p Later proposal', message_thread_id: session.threadId }, participant);
    const later = app.messages.at(-1)!;
    const laterApprove = buttons(later).find(button => button.callback_data?.startsWith('prompt:approve:'));
    assert.ok(laterApprove?.callback_data);
    app.setCurrentMember({ username: ownerUsername, status: 'creator' });
    await app.callback(laterApprove.callback_data, later);
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: '/skill:pdf-tools\n\nLater proposal' });
  } finally { await app.close(); }
});


test('inline skill search selects only for its original user and topic', async () => {
  const app = await createSmokeApp();
  try {
    const session = await seed(app);
    await app.update({ text: '/skills', message_thread_id: session.threadId });
    const picker = app.messages.at(-1)!;
    const search = buttons(picker).find(button => button.switch_inline_query_current_chat !== undefined)?.switch_inline_query_current_chat;
    assert.ok(search);
    await app.inlineQuery(`${search}pdf`, participant);
    assert.deepEqual(app.inlineAnswers.at(-1)?.results, []);
    await app.inlineQuery(`${search}pdf`);
    const results = app.inlineAnswers.at(-1)?.results as { title: string; input_message_content: { message_text: string; entities: unknown[] } }[];
    assert.equal(results.length, 1);
    const content = results[0]!.input_message_content;
    const selection = {
      text: content.message_text, entities: content.entities,
      via_bot: { id: botId, is_bot: true, first_name: 'OMP', username: 'FixtureOmpBot' },
    };
    const callback = buttons(picker).find(button => button.callback_data?.startsWith('skills:add:') && button.callback_data.endsWith(':1'))?.callback_data;
    assert.ok(callback);
    app.setCurrentMember({ username: ownerUsername, status: 'creator' });
    const otherAdmin = { ...participant, username: ownerUsername };
    app.setUserRole(otherAdmin,'administrator');
    await app.callback(callback, picker, otherAdmin);
    await app.update({ ...selection, message_thread_id: session.threadId }, otherAdmin);
    await app.update({ text: '/p Other user', message_thread_id: session.threadId }, otherAdmin);
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: 'Other user' });
    await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Inline wrong topic' } });
    await app.callback(callback, { ...picker, message_thread_id: 42 });
    await app.update({ ...selection, message_thread_id: 42 });
    await app.update({ text: '/p Other topic', message_thread_id: 42 });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: 'Other topic' });
    await app.update({ ...selection, message_thread_id: session.threadId });
    const count = prompts(app).length;
    await app.update({ text: '/p Inline task', message_thread_id: session.threadId });
    assert.equal(prompts(app).length, count + 1);
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: '/skill:pdf-tools\n\nInline task' });
    await app.update({ text: '/p After inline', message_thread_id: session.threadId });
    assert.deepEqual(prompts(app).at(-1), { t: 'prompt', text: 'After inline' });
  } finally { await app.close(); }
});
