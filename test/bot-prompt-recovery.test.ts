import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Bot } from 'grammy';
import type { SessionEntry } from '@oh-my-pi/pi-wire';
import { createBot, type BotService } from '../src/bot.js';
import { Store } from '../src/store.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';
import { botId, botToken } from './telegram-data.js';

function receipt(text: string, id: string): SessionEntry {
  return {
    type: 'custom_message',
    customType: 'collab-prompt',
    content: text,
    details: { from: 'Telegram @fixture_bot' },
    display: true,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}
function answer(id: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: id }],
      model: 'fixture',
      timestamp: Date.now(),
      stopReason: 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { total: 0 },
      },
    },
  };
}

for (const recovery of [
  'disconnect',
  'restart',
  'claimed initial restart',
  'error then disconnect',
] as const) {
  test(
    `accepted prompt destination survives ${recovery} before its receipt is observed`,
    { timeout: 15000 },
    async () => {
      const restarting = recovery === 'restart' || recovery === 'claimed initial restart';
      const app = await createSmokeApp({ holdPromptReceipts: true, persistentStore: restarting });
      let restarted: BotService | undefined;
      let reopened: Store | undefined;
      try {
        await app.update({ text: '/setup' });
        const claimed = recovery === 'claimed initial restart';
        const expected = claimed ? 8100 : 8001;
        await app.update({
          message_id: claimed ? expected : 8000,
          text: claimed ? '/new Claimed task' : '/new Task A',
        });
        const targetSession = app.store.listSessions(botId)[0]!;
        await eventually(() =>
          app.accepted.some(
            (frame) => frame.t === 'prompt' && frame.text === (claimed ? 'Claimed task' : 'Task A'),
          ),
        );
        const first = receipt('Task A', 'receipt-A');
        if (first.type === 'custom_message')
          first.details = { from: `Telegram @${app.bot.botInfo!.username}` };
        if (!claimed) {
          app.appendEntry(first);
          app.emit({ t: 'entry', entry: first });
          await eventually(() => app.store.getReplyTarget(targetSession.id) === 8000);
          await app.update({
            message_id: expected,
            message_thread_id: targetSession.threadId,
            text: '/p Task B',
          });
        } else {
          assert.equal(app.store.hasPendingInitialTask(targetSession.id), false);
        }
        const pending = receipt(
          claimed ? 'Claimed task' : 'Task B',
          claimed ? 'receipt-initial' : 'receipt-B',
        );
        if (pending.type === 'custom_message')
          pending.details = { from: `Telegram @${app.bot.botInfo!.username}` };
        const recoveredAnswer = answer(`answer-${recovery}`);
        const recoveredEntries = claimed
          ? [pending, recoveredAnswer]
          : [first, pending, recoveredAnswer];
        if (recovery === 'error then disconnect')
          app.emit({ t: 'error', message: 'Fixture ambiguous host failure after submission' });
        const accepted = [...app.accepted];
        const before = app.messages.length;
        if (!restarting) {
          app.appendEntry(pending);
          app.appendEntry(recoveredAnswer);
          app.disconnect();
          await app.service.ensureMirroring(targetSession, await app.runtime.ensure(targetSession));
        } else {
          await app.service.close();
          reopened = new Store(join(app.config.dataDir, 'telegram.sqlite'));
          restarted = createBot({
            config: app.config,
            botConfig: app.config.bots[0]!,
            token: botToken,
            store: reopened,
            runtime: app.runtime,
            bot: new Bot(botToken, { client: { apiRoot: app.telegramUrl } }),
            connect: async (binding, _name, handlers) => {
              handlers.onFrame({
                t: 'welcome',
                proto: 3,
                header: {
                  type: 'session',
                  id: binding.sessionId,
                  cwd: targetSession.instancePath,
                  timestamp: new Date().toISOString(),
                },
                state: {
                  cwd: targetSession.instancePath,
                  isStreaming: false,
                  queuedMessageCount: 0,
                  participants: [],
                },
                agents: [],
                entryCount: recoveredEntries.length,
              });
              handlers.onFrame({ t: 'snapshot-chunk', entries: recoveredEntries, final: true });
              return {
                send() {
                  assert.fail('Recovery must not submit work');
                },
                close() {},
              };
            },
          });
          await restarted.initialize();
          await restarted.ensureMirroring(targetSession, await app.runtime.ensure(targetSession));
        }
        await eventually(() =>
          app.messages.slice(before).some((message) => message.rich_message !== undefined),
        );
        const delivered = app.messages
          .slice(before)
          .find((message) => message.rich_message !== undefined)!;
        assert.deepEqual(delivered.reply_parameters, {
          message_id: expected,
          allow_sending_without_reply: true,
        });
        assert.equal((reopened ?? app.store).getReplyTarget(targetSession.id), expected);
        assert.deepEqual(app.accepted, accepted);
        if (restarted) {
          await restarted.ensureMirroring(targetSession, await app.runtime.ensure(targetSession));
          assert.equal(reopened!.getReplyTarget(targetSession.id), expected);
        }
      } finally {
        await restarted?.close();
        reopened?.close();
        await app.close();
      }
    },
  );
}

test(
  'duplicate receipts and acknowledged controls retain the latest accepted prompt',
  { timeout: 15000 },
  async () => {
    const app = await createSmokeApp({ holdPromptReceipts: true, ackUiResponses: true });
    try {
      await app.update({ text: '/setup' });
      await app.update({ message_id: 8200, text: '/new Task A' });
      const session = app.store.listSessions(botId)[0]!;
      await eventually(() =>
        app.accepted.some((frame) => frame.t === 'prompt' && frame.text === 'Task A'),
      );
      const first = receipt('Task A', 'policy-A');
      const second = receipt('Task B', 'policy-B');
      for (const entry of [first, second])
        if (entry.type === 'custom_message')
          entry.details = { from: `Telegram @${app.bot.botInfo!.username}` };
      app.emit({ t: 'entry', entry: first });
      await eventually(() => app.store.getReplyTarget(session.id) === 8200);
      await app.update({
        message_id: 8201,
        message_thread_id: session.threadId,
        text: '/p Task B',
      });
      app.emit({ t: 'entry', entry: second });
      await eventually(() => app.store.getReplyTarget(session.id) === 8201);
      app.emit({ t: 'entry', entry: first });
      assert.equal(app.store.getReplyTarget(session.id), 8201);
      const acknowledged = (id: number) =>
        app.reactions.some(
          (reaction) =>
            reaction.message_id === id && JSON.stringify(reaction.reaction).includes('🤝'),
        );
      app.emit({ t: 'ui-request', request: { kind: 'editor', reqId: 51, title: 'Question' } });
      await eventually(() =>
        app.messages.some((message) =>
          JSON.stringify(message.reply_markup)?.includes('force_reply'),
        ),
      );
      const editor = app.messages.findLast((message) =>
        JSON.stringify(message.reply_markup)?.includes('force_reply'),
      )!;
      await app.update({
        message_id: 8220,
        message_thread_id: session.threadId,
        text: 'Answer',
        reply_to_message: {
          message_id: editor.message_id,
          from: { id: botId, is_bot: true, first_name: 'OMP' },
        },
      });
      await eventually(() => acknowledged(8220));
      assert.deepEqual(app.accepted.at(-1), { t: 'ui-response', reqId: 51, value: 'Answer' });
      assert.equal(app.store.getReplyTarget(session.id), 8201);
      await app.update({ message_id: 8221, message_thread_id: session.threadId, text: '/stop' });
      app.emit({
        t: 'event',
        event: {
          type: 'notice',
          level: 'info',
          source: 'collab',
          message: `Telegram @${app.bot.botInfo!.username} interrupted`,
        },
      });
      await eventually(() => acknowledged(8221));
      assert.equal(app.store.getReplyTarget(session.id), 8201);
      await app.update({ message_id: 8222, message_thread_id: session.threadId, text: '/kill' });
      await eventually(() => acknowledged(8222));
      assert.equal(await app.runtime.isRunning(session), false);
      assert.equal(app.store.getReplyTarget(session.id), 8201);
    } finally {
      await app.close();
    }
  },
);
