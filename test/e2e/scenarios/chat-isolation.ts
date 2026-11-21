import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BotError, GrammyError } from 'grammy';
import test from 'node:test';
import { z } from 'zod';
import { readConfig, writeConfig } from '../../../src/config.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { createManagedTopic, enrollForum, sendDocumentAlbum, submitCallback } from '../helpers/telegram-actions.js';
import { createTelegramTestApi, createTelegramTestForum } from '../helpers/telegram-resources.js';
import { completeWriteTask, createWriteTask, writeScenario } from '../helpers/model-tasks.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';
import { bounded } from '../helpers/async.js';
import { withFailureService } from '../helpers/failure-service.js';

const observedCall = z.object({
  method: z.string(),
  payload: z.object({
    chat_id: z.number().optional(),
    scope: z.object({ chat_id: z.number().optional() }).optional(),
  }),
  result: z.object({ ok: z.boolean() }),
});

// Telegram implements forum deletion through channels.deleteChannel, not a
// synthetic Bot API update.
// https://github.com/tdlib/td/blob/master/td/telegram/ChatManager.cpp (DeleteChannelQuery)
export function registerChatIsolation(): void {
  test('a deleted assigned forum cannot prevent another forum from restarting and executing tasks', { timeout: 300000 }, async t => {
    const task = createWriteTask('chat-isolation');
    const app = await setupCollaborationTest(t, { scenarios: [writeScenario(task)] });
    await enrollForum(app);
    const healthy = await createManagedTopic(app);
    const removed = await withTelegramTestDeadline('secondary forum provisioning', telegramTestTimeouts.provision, t.signal,
      signal => createTelegramTestForum(app.telegram.user, app.telegram.bot, { signal }));
    t.after(() => removed.close());
    const topic = await app.telegram.api.createForumTopic(removed.chatId, 'Deleted forum session');
    const entry = await app.telegram.api.sendMessage(removed.chatId, 'Session entry', {
      message_thread_id: topic.message_thread_id,
      reply_markup: { inline_keyboard: [[{ text: 'Session', url: 'https://example.com' }]] },
    });
    app.store.enrollGroup(app.telegram.bot.id, removed.chatId);
    const orphan = app.store.createSession({
      botId: app.telegram.bot.id, chatId: removed.chatId, threadId: topic.message_thread_id,
      instanceId: 1, cwd: app.omp.workspace,
    }, 'Deleted forum session');
    app.store.setSessionEntry(orphan.id, entry.message_id, 'stale');
    const healthyEntry = app.store.getSessionEntry(healthy.id)!;
    app.store.setSessionEntry(healthy.id, healthyEntry.messageId, 'stale');
    const config = readConfig(app.config.configPath);
    config.instances[0]!.chats.unshift({ botId: app.telegram.bot.id, chatId: removed.chatId });
    writeConfig(config);
    await removed.close();
    const start = app.apiCalls.length;
    await app.restart();
    const calls = z.array(observedCall).parse(app.apiCalls.slice(start));
    const failed = calls.find(call => call.method === 'editMessageReplyMarkup' &&
      call.payload.chat_id === removed.chatId);
    assert.ok(failed, 'startup must attempt the retained entry in the deleted forum');
    assert.equal(failed.result.ok, false);
    assert.notEqual(app.store.getSessionEntry(orphan.id)?.markup, JSON.stringify({ inline_keyboard: [] }));
    assert.equal(app.store.getSessionEntry(healthy.id)?.markup, JSON.stringify({ inline_keyboard: [] }));
    assert.ok(calls.some(call => call.method === 'setMyCommands' &&
      call.payload.scope?.chat_id === app.telegram.forum.chatId && call.result.ok));
    const sent = await app.sendAndWait(`/p ${task.prompt}`, healthy.threadId);
    await completeWriteTask(app, task, sent, healthy.threadId);
    assert.equal(app.store.getSession(orphan.id)?.status, 'open');
    await app.pause();
    for (const mode of ['album', 'callback'] as const) {
      await withFailureService(app, t.signal, async owner => {
        // Exercise actual Telegram authentication failures without revoking the leased bot.
        // Only the selected request uses an invalid secret for this owned bot identity.
        const invalid = createTelegramTestApi(`${app.telegram.bot.id}:${randomBytes(32).toString('base64url')}`, t.signal);
        const failures: GrammyError[] = [];
        const panel = Promise.withResolvers<{ messageId: number; data: string }>();
        let callbackId: string | undefined;
        owner.bot.api.config.use(async (previous, method, payload, signal) => {
          if ((mode === 'album' && method === 'setMessageReaction') ||
              (mode === 'callback' && method === 'answerCallbackQuery')) {
            try {
              if (method === 'setMessageReaction') {
                const reaction = z.object({
                  chat_id: z.number(), message_id: z.number(),
                  reaction: z.array(z.object({ type: z.literal('emoji'), emoji: z.literal('👀') })),
                }).parse(payload);
                await invalid.raw.setMessageReaction(reaction, signal);
              } else {
                const query = z.object({
                  callback_query_id: z.string(), text: z.string().optional(),
                  show_alert: z.boolean().optional(), url: z.string().optional(), cache_time: z.number().optional(),
                }).parse(payload);
                callbackId = query.callback_query_id;
                await invalid.raw.answerCallbackQuery(query, signal);
              }
            } catch (error) {
              if (error instanceof GrammyError) failures.push(error);
              throw error;
            }
            throw new Error('Telegram unexpectedly authorized the invalid test credential');
          }
          const response = await previous(method, payload, signal);
          if (mode === 'callback' && method === 'sendMessage') {
            const parsed = z.object({
              ok: z.literal(true), result: z.object({
                message_id: z.number(),
                reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({ callback_data: z.string().optional() }))) }),
              }),
            }).safeParse(response);
            const data = parsed.success ? parsed.data.result.reply_markup.inline_keyboard.flat()
              .find(button => button.callback_data?.startsWith('settings:'))?.callback_data : undefined;
            if (parsed.success && data) panel.resolve({ messageId: parsed.data.result.message_id, data });
          }
          return response;
        });
        if (mode === 'album') {
          await sendDocumentAlbum(app, healthy.threadId, '/p This rejected album must not reach OMP', [
            { name: 'first.txt', bytes: Buffer.from('first') },
            { name: 'second.txt', bytes: Buffer.from('second') },
          ]);
          const error = await owner.failure();
          assert.equal(failures.length, 1);
          assert.equal(failures[0]!.error_code, 401);
          assert.equal(error, failures[0], 'detached fatal album failure reaches start unchanged');
        } else {
          await app.send('/settings', healthy.threadId);
          const current = await bounded(panel.promise, t.signal);
          const click = submitCallback(app, { kind: '/settings', messageId: current.messageId, buttons: [current.data] }, current.data);
          const clickResult = click.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
          const error = await owner.failure();
          assert.ok(error instanceof BotError);
          assert.equal(failures.length, 2);
          assert.ok(failures.every(failure => failure.error_code === 401));
          assert.equal(error.error, failures[0], 'callback cleanup must not replace the primary failure');
          assert.ok(callbackId);
          // The failed service cannot acknowledge; the valid fixture API owns client cleanup.
          await app.telegram.api.answerCallbackQuery(callbackId);
          const result = await bounded(clickResult, t.signal);
          if (!result.ok) throw result.error;
        }
      });
    }
  });
}
