import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Store, type MessageAnchor } from '../src/store.js';

const topic = {botId:1,chatId:-100,threadId:42,instancePath:'/fixture'};
const sender = 'Telegram @fixture_bot';
const target = (ompSessionId: string, entryId: string, parentEntryId: string | null = null) => ({ompSessionId,entryId,parentEntryId});

test('message anchors preserve receipt aliases and exact native identity across disk reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-message-anchors-'));
  const filename = join(directory, 'telegram.sqlite');
  let store = new Store(filename);
  try {
    const session = store.createSession(topic, 'Anchors');
    const content = {text:'Accepted task'};
    store.recordPromptMessageAlias(session.id, 100, 101);
    store.recordPromptMessageAlias(session.id, 100, 102);
    store.recordPromptSubmission(session.id, 'omp-original', sender, content, 100);
    store.close();
    store = new Store(filename);
    const boundary = store.beginPromptReceiptSnapshot(session.id, 'omp-original');
    const prompt = target('omp-original', 'prompt-entry', 'previous-entry');
    store.recordPromptReceipt(session.id, prompt, sender, content, boundary);
    const answer: MessageAnchor = {...target('omp-original', 'answer-entry', 'prompt-entry'),kind:'assistant',partIndex:0};
    store.recordMessageAnchor(session.id, topic.chatId, 200, answer);
    store.recordMessageAnchor(session.id, topic.chatId, 201, {...answer,partIndex:1});
    store.rememberReply(session.id, answer.ompSessionId, answer.entryId);
    store.advanceSessionGeneration(session.id);
    store.close();
    store = new Store(filename);
    for (const messageId of [100,101,102])
      assert.deepEqual(store.getMessageAnchor(session.id, 'omp-original', topic.chatId, messageId), {...prompt,kind:'collab-prompt',partIndex:0});
    assert.deepEqual(store.getMessageAnchor(session.id, 'omp-original', topic.chatId, 200), answer);
    assert.deepEqual(store.getMessageAnchor(session.id, 'omp-original', topic.chatId, 201), {...answer,partIndex:1});
    assert.equal(store.rememberReply(session.id, 'omp-original', 'answer-entry'), false);
    assert.equal(store.rememberReply(session.id, 'omp-fork', 'answer-entry'), true);
    assert.equal(store.getMessageAnchor(session.id, 'omp-fork', topic.chatId, 100), undefined);
    assert.deepEqual(store.recordPromptReceipt(session.id, prompt, sender, content), {fresh:false,messageId:100});
  } finally {
    store.close();
    await rm(directory, {recursive:true,force:true});
  }
});

test('message anchors isolate native sessions, topics and chats and reject conflicting targets atomically', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(topic, 'Original');
    const other = store.createSession({...topic,botId:2}, 'Other bot');
    const content = {text:'Same prompt'};
    for (const ompSessionId of ['omp-one','omp-two'])
      store.recordPromptSubmission(session.id, ompSessionId, sender, content, 100);
    const first = target('omp-one', 'same-entry', 'first-parent');
    const second = target('omp-two', 'same-entry', 'second-parent');
    store.recordPromptReceipt(session.id, first, sender, content);
    store.recordPromptReceipt(session.id, second, sender, content);
    assert.deepEqual(store.getMessageAnchor(session.id, 'omp-one', topic.chatId, 100), {...first,kind:'collab-prompt',partIndex:0});
    assert.deepEqual(store.getMessageAnchor(session.id, 'omp-two', topic.chatId, 100), {...second,kind:'collab-prompt',partIndex:0});
    assert.equal(store.getMessageAnchor(other.id, 'omp-one', topic.chatId, 100), undefined);
    assert.equal(store.getMessageAnchor(session.id, 'omp-one', topic.chatId - 1, 100), undefined);
    const existing: MessageAnchor = {...target('omp-one', 'assistant-entry'),kind:'assistant',partIndex:0};
    store.recordMessageAnchor(session.id, topic.chatId, 201, existing);
    store.recordMessageAnchor(session.id, topic.chatId, 201, existing);
    store.recordPromptMessageAlias(session.id, 200, 201);
    store.recordPromptSubmission(session.id, 'omp-one', sender, content, 200);
    const receipt = target('omp-one', 'conflicting-receipt');
    assert.throws(() => store.recordPromptReceipt(session.id, receipt, sender, content), /Conflicting message anchor/);
    assert.equal(store.getMessageAnchor(session.id, 'omp-one', topic.chatId, 200), undefined);
    assert.deepEqual(store.getMessageAnchor(session.id, 'omp-one', topic.chatId, 201), existing);
    assert.equal(store.db.prepare('SELECT entry_id FROM prompt_receipts WHERE entry_id=?').get(receipt.entryId), undefined);
    assert.equal(Number(store.db.prepare('SELECT message_id FROM prompt_submissions WHERE session_id=?').get(session.id)?.message_id), 200);
  } finally { store.close(); }
});

test('message anchors never resolve ambiguous or foreign prompt receipts through aliases', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(topic, 'Ambiguous');
    const content = {text:'Repeated task'};
    store.recordPromptMessageAlias(session.id, 100, 101);
    store.recordPromptSubmission(session.id, 'omp-one', sender, content, 100);
    store.beginPromptReceiptSnapshot(session.id, 'omp-one');
    store.recordPromptSubmission(session.id, 'omp-one', sender, content, 102);
    store.recordPromptReceipt(session.id, target('omp-one', 'receipt-one'), sender, content);
    store.recordPromptReceipt(session.id, target('omp-one', 'receipt-two'), sender, content);
    store.recordPromptReceipt(session.id, target('omp-one', 'foreign-receipt'), 'Web participant', content);
    for (const messageId of [100,101,102])
      assert.equal(store.getMessageAnchor(session.id, 'omp-one', topic.chatId, messageId), undefined);
    store.recordPromptSubmission(session.id, 'omp-one', sender, content, 103);
    const recovered = target('omp-one', 'unambiguous-entry');
    store.recordPromptReceipt(session.id, recovered, sender, content);
    assert.deepEqual(store.getMessageAnchor(session.id, 'omp-one', topic.chatId, 103), {...recovered,kind:'collab-prompt',partIndex:0});
  } finally { store.close(); }
});
