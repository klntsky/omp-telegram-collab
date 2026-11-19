import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Conversation, Long } from '@mtcute/node';
import type { CollaborationTest } from './collaboration-fixture.js';
import { withTelegramTestLock } from '../../../scripts/lib/telegram-test-lock.js';
import { bounded } from './async.js';

export async function enableInlineMode(app: CollaborationTest): Promise<void> {
  if ((await app.bot.api.getMe()).supports_inline_queries) return;
  // Inline mode is a BotFather setting, not a Bot API capability to synthesize:
  // https://mtcute.dev/guide/topics/inline-mode (Implementing inline mode).
  await withTelegramTestLock('botfather', app.telegram.user.signal, async () => {
    const conversation = new Conversation(app.telegram.user.client, 'BotFather');
    await conversation.with(async () => {
      for (const text of ['/cancel', '/setinline', `@${app.telegram.bot.username}`, 'Search skills']) {
        const signal = AbortSignal.any([app.telegram.user.signal, AbortSignal.timeout(30000)]);
        const sent = await bounded(conversation.sendText(text), signal);
        const reply = await bounded(conversation.waitForResponse(undefined, { message: sent.id, timeout: 30000 }), signal);
        if (/too many|sorry|invalid|not a bot|don't have/i.test(reply.text)) {
          throw new Error(`BotFather inline provisioning failed:\n${reply.text}`);
        }
      }
    });
  });
  assert.equal((await app.bot.api.getMe()).supports_inline_queries, true, 'BotFather must enable inline queries for the leased bot');
}

export async function sendInlineSkill(app: CollaborationTest, threadId: number): Promise<number> {
  const start = app.apiCalls.length;
  await app.sendAndWait('/skills', threadId);
  const payload = app.apiCalls.slice(start).find(call => call.method === 'sendMessage' &&
    JSON.stringify(call.payload).includes('switch_inline_query_current_chat'))?.payload;
  assert.ok(payload && typeof payload === 'object' && 'reply_markup' in payload);
  const markup = payload.reply_markup as { inline_keyboard: Array<Array<{ switch_inline_query_current_chat?: string }>> };
  const query = markup.inline_keyboard.flat().find(button => button.switch_inline_query_current_chat)?.switch_inline_query_current_chat;
  assert.ok(query);
  const user = app.telegram.user;
  const peer = await user.client.resolvePeer(app.telegram.forum.chat);
  const botPeer = await user.client.resolvePeer(app.telegram.bot.username);
  assert.ok(botPeer._ === 'inputPeerUser');
  const bot = { _: 'inputUser' as const, userId: botPeer.userId, accessHash: botPeer.accessHash };
  // Raw MTProto is mtcute's supported user-side inline workflow. TDLib's
  // GetInlineBotResultsQuery sends the same RPC, and Bot API JsonMessage::store
  // preserves via_bot and text entities even when embedded as a reply:
  // https://github.com/tdlib/td/blob/master/td/telegram/InlineQueriesManager.cpp
  // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
  const results = await user.call({ _: 'messages.getInlineBotResults', bot, peer, query: `${query}e2e-review`, offset: '' });
  const result = results.results[0];
  assert.ok(result, 'Real inline query must return the fixture skill');
  const updates = await user.call({ _: 'messages.sendInlineBotResult', peer, queryId: results.queryId,
    id: result.id, randomId: Long.fromBytes([...randomBytes(8)]),
    replyTo: { _: 'inputReplyToMessage', replyToMsgId: threadId, topMsgId: threadId },
  });
  assert.ok(updates._ === 'updates' || updates._ === 'updatesCombined');
  const sent = updates.updates.find(update => update._ === 'updateNewChannelMessage' || update._ === 'updateNewMessage');
  assert.ok(sent && (sent._ === 'updateNewChannelMessage' || sent._ === 'updateNewMessage'));
  const message = sent.message;
  assert.equal(message._, 'message');
  assert.ok(message._ === 'message' && message.viaBotId);
  assert.ok(message.entities?.some(entity => entity._ === 'messageEntityTextUrl'));
  await app.waitForMessageHandled(message.id);
  return message.id;
}
