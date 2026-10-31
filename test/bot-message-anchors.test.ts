import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CustomMessageEntry, MessageEntry } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';
import { botId, chatId } from './telegram-data.js';

function returnedMessageId(value: unknown): number {
  assert.ok(value && typeof value === 'object' && 'message_id' in value);
  assert.ok(typeof value.message_id === 'number');
  return value.message_id;
}

function answer(id: string, parentId: string, text: string): MessageEntry {
  return {type:'message',id,parentId,timestamp:new Date(1000).toISOString(),message:{
    role:'assistant',content:[{type:'text',text}],model:'fixture',timestamp:1000,stopReason:'stop',
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},
  }};
}

test('message anchors bind prompt originals and forwarded copies only after native admission', async () => {
  const app = await createSmokeApp({holdPromptReceipts:true,skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    await app.update({message_id:8000,text:'/new Accepted task',reply_to_message:{message_id:7999,text:'Context only'}});
    const session = app.store.listSessions(botId)[0]!;
    const binding = await app.runtime.ensure(session);
    const forwarded = app.messages.find(message => message.forwarded_message_id === 8000)!;
    const context = app.messages.find(message => message.forwarded_message_id === 7999)!;
    assert.equal(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, 8000), undefined);
    const receipt: CustomMessageEntry = {
      type:'custom_message',customType:'collab-prompt',content:'> Context only\n\nAccepted task',
      details:{from:`Telegram @${app.bot.botInfo!.username}`},display:true,
      id:'accepted-prompt',parentId:'previous-entry',timestamp:new Date().toISOString(),
    };
    app.appendEntry(receipt);
    app.emit({t:'entry',entry:receipt});
    const expected = {ompSessionId:binding.sessionId,entryId:receipt.id,parentEntryId:receipt.parentId,kind:'collab-prompt',partIndex:0};
    for (const messageId of [8000,Number(forwarded.message_id)])
      assert.deepEqual(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, messageId), expected);
    for (const messageId of [7999,Number(context.message_id)])
      assert.equal(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, messageId), undefined);
    app.disconnect();
    await app.service.ensureMirroring(session, binding);
    assert.deepEqual(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, 8000), expected);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{t:'prompt',text:receipt.content}]);
  } finally { await app.close(); }
});

test('message anchors persist every confirmed answer chunk before sending the next and deduplicate entry replay', async () => {
  const app = await createSmokeApp({skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    await app.update({message_id:8100,text:'/new Task'});
    const session = app.store.listSessions(botId)[0]!;
    const binding = await app.runtime.ensure(session);
    const entry = answer('long-answer', 'accepted-1', 'a'.repeat(65537));
    const delivered: number[] = [];
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method !== 'sendRichMessage') return previous(method, payload, signal);
      if (delivered.length) {
        const last = delivered.at(-1)!;
        assert.deepEqual(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, last), {
          ompSessionId:binding.sessionId,entryId:entry.id,parentEntryId:entry.parentId,kind:'assistant',partIndex:delivered.length - 1,
        });
      }
      const response = await previous(method, payload, signal);
      if (response.ok) delivered.push(returnedMessageId(response.result));
      return response;
    });
    app.emit({t:'event',event:{type:'message_end',message:entry.message}});
    app.emit({t:'entry',entry});
    app.appendEntry(entry);
    await eventually(() => delivered.length === 3 && app.store.getMessageAnchor(session.id, binding.sessionId, chatId, delivered[2]!) !== undefined);
    for (const [partIndex,messageId] of delivered.entries())
      assert.deepEqual(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, messageId), {
        ompSessionId:binding.sessionId,entryId:entry.id,parentEntryId:entry.parentId,kind:'assistant',partIndex,
      });
    app.emit({t:'entry',entry});
    app.disconnect();
    await app.service.ensureMirroring(session, binding);
    const next = answer('second-answer', 'long-answer', 'Next response');
    app.emit({t:'entry',entry:next});
    await eventually(() => app.messages.some(message => app.store.getMessageAnchor(session.id, binding.sessionId, chatId, Number(message.message_id))?.entryId === next.id));
    const longAnchors = app.store.db.prepare("SELECT message_id FROM message_anchors WHERE session_id=? AND entry_id='long-answer' ORDER BY part_index").all(session.id);
    assert.deepEqual(longAnchors.map(row => Number(row.message_id)), delivered.slice(0,3));
    assert.equal(delivered.length, 4);
  } finally { await app.close(); }
});

test('message anchors distinguish persisted entries with identical output and omit unconfirmed sends', async () => {
  const app = await createSmokeApp({skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Task'});
    const session = app.store.listSessions(botId)[0]!;
    const binding = await app.runtime.ensure(session);
    const first = answer('first-answer', 'accepted-1', 'Identical response');
    const second = answer('second-answer', first.id, 'Identical response');
    app.emit({t:'entry',entry:first});
    app.emit({t:'entry',entry:second});
    await eventually(() => app.store.db.prepare("SELECT entry_id FROM message_anchors WHERE session_id=? AND kind='assistant'").all(session.id).length === 2);
    const anchors = app.store.db.prepare("SELECT entry_id,parent_entry_id FROM message_anchors WHERE session_id=? AND kind='assistant' ORDER BY message_id").all(session.id);
    assert.deepEqual(anchors.map(row => [row.entry_id,row.parent_entry_id]), [[first.id,first.parentId],[second.id,second.parentId]]);
    const failure = new Error('Fixture response lost after delivery');
    let sentMessageId: number | undefined;
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        const response = await previous(method, payload, signal);
        if (method === 'sendRichMessage' && response.ok) {
          sentMessageId = returnedMessageId(response.result);
          throw failure;
        }
        return response;
      });
      app.emit({t:'entry',entry:answer('unknown-delivery', second.id, 'Unconfirmed response')});
      await eventually(() => errors.length > 0);
      assert.ok(sentMessageId);
      assert.equal(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, sentMessageId), undefined);
      assert.equal(errors[0]![1], failure);
    } finally { console.error = original; }
  } finally { await app.close(); }
});
