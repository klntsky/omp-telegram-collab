import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { once } from 'node:events';
import { z } from 'zod';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Question was not relayed');
    await delay(20);
  }
}

test('long agent questions retain full text and descriptions with compact indexed answer buttons', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Start' });
    const session = app.store.listSessions(botId)[0]!;
    const title = 'Question <literal> & **Markdown**\n' + 'Long question 😀 '.repeat(600);
    const label = 'An option whose full label must not become button text '.repeat(8);
    const description = 'Full tradeoff details, including <markup> and Unicode 😀.';
    const before = app.messages.length;
    app.emit({ t: 'ui-request', request: { kind: 'select', reqId: 71, title, options: [{ label, description }, 'Keep existing'], helpText: 'Choose carefully.' } });
    await eventually(() => app.messages.slice(before).some(message => JSON.stringify(message.reply_markup)?.includes('ask:')));
    const messages = app.messages.slice(before).filter(message => message.message_thread_id === session.threadId);
    const body = messages.map(message => message.text).join('');
    assert.ok(body.includes(title));
    assert.ok(body.includes(label));
    assert.ok(body.includes(description));
    assert.ok(body.includes('Choose carefully.'));
    for (const message of messages) {
      assert.ok(String(message.text).length <= 4000);
      assert.equal(message.parse_mode, undefined);
      assert.ok(!/[\uD800-\uDBFF]$/.test(String(message.text)));
    }
    const question = messages.at(-1)!;
    const { inline_keyboard: keyboard } = z.object({inline_keyboard:z.array(z.array(z.object({text:z.string(),callback_data:z.string()})))}).parse(question.reply_markup);
    assert.deepEqual(keyboard.map(row => row.map(button => button.text)), [['1️⃣', '2️⃣'], ['Cancel']]);
    const count = app.accepted.length;
    await app.callback(keyboard[0]![0]!.callback_data, question);
    assert.deepEqual(app.accepted.slice(count), [{ t: 'ui-response', reqId: 71, value: label }]);
    await eventually(() => String(question.text).includes(label) && String(question.text).includes('1️⃣'));
    assert.deepEqual(question.reply_markup, {inline_keyboard:[]});
    await app.callback(keyboard[0]![0]!.callback_data, question);
    assert.equal(app.accepted.length, count + 1);
  } finally { await app.close(); }
});

for (const allMessagesArePrompts of [true,false]) {
test(`custom choice submits multiline text as an answer with all_messages_are_prompts=${allMessagesArePrompts}`, async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    if (!allMessagesArePrompts) await app.callback('setup:prompts:false',app.messages.at(-1)!);
    await app.update({ text: '/new Start' });
    const session = app.store.listSessions(botId)[0]!;
    app.emit({ t: 'ui-request', request: { kind: 'select', reqId: 81, title: 'Deployment target?', options: ['Production', 'Other (type your own)'] } });
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('ask:')));
    const choice = app.messages.at(-1)!;
    const { inline_keyboard } = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(choice.reply_markup);
    await app.callback(inline_keyboard[0]![1]!.callback_data, choice);
    assert.deepEqual(app.accepted.at(-1), { t: 'ui-response', reqId: 81, value: 'Other (type your own)' });
    await eventually(() => String(choice.text).includes('Other (type your own)') && String(choice.text).includes('2️⃣'));
    app.emit({ t: 'ui-request-end', reqId: 81 });
    app.emit({ t: 'ui-request', request: { kind: 'editor', reqId: 82, title: 'Enter your deployment target', prefill: 'Suggested: staging' } });
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
    const editor = app.messages.at(-1)!;
    assert.equal(editor.message_thread_id, session.threadId);
    assert.deepEqual(editor.reply_markup, { force_reply: true, input_field_placeholder: 'Type your custom answer' });
    assert.ok(app.messages.some(message => String(message.text).includes('Suggested: staging')));
    const text = '/new this is an answer, not a new session\n  Keep <literal> **text** 😀  ';
    const before = app.accepted.length;
    await app.update({ message_id:8200,message_thread_id:session.threadId,text,reply_to_message:{message_id:editor.message_id,from:{id:botId,is_bot:true,first_name:'OMP'}} });
    assert.deepEqual(app.accepted.slice(before), [{ t: 'ui-response', reqId: 82, value: text }]);
    assert.equal(app.store.listSessions(botId).length, 1);
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 8200).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    app.emit({t:'ui-request-end',reqId:81});
    assert.ok(!app.reactions.some(reaction => reaction.message_id === 8200 && JSON.stringify(reaction.reaction).includes('🤝')));
    app.emit({t:'ui-request-end',reqId:82});
    await eventually(() => app.reactions.some(reaction => reaction.message_id === 8200 && JSON.stringify(reaction.reaction).includes('🤝')));
    app.emit({t:'ui-request-end',reqId:82});
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 8200).map(reaction => reaction.reaction),[
      [{type:'emoji',emoji:'👀'}],[{type:'emoji',emoji:'🤝'}],
    ]);
    await app.update({ message_thread_id: session.threadId, text: 'A late duplicate answer', reply_to_message: { message_id: editor.message_id, from: { id: botId, is_bot: true, first_name: 'OMP' } } });
    assert.equal(app.accepted.length, before + 1, 'a stale editor reply must not become a new instruction');
  } finally { await app.close(); }
});
}

test('question answers reject copied buttons, removed members, ended requests and disconnected listeners', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Start' });
    app.emit({ t: 'ui-request', request: { kind: 'select', reqId: 91, title: 'Choose', options: ['One', 'Two'] } });
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('ask:')));
    const question = app.messages.at(-1)!;
    const { inline_keyboard } = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(question.reply_markup);
    const data = inline_keyboard[0]![0]!.callback_data;
    const count = app.accepted.filter(frame => frame.t === 'ui-response').length;
    await app.callback(data, { ...question, message_thread_id: 99 });
    await app.callback(data, { ...question, message_id: Number(question.message_id) + 100 });
    await app.callback(data, { ...question, forward_date: 1 });
    app.setMember(false);
    await app.callback(data, question);
    app.setMember(true);
    app.emit({ t: 'ui-request-end', reqId: 91 });
    await app.callback(data, question);
    assert.equal(app.accepted.filter(frame => frame.t === 'ui-response').length, count);
    app.emit({ t: 'ui-request', request: { kind: 'editor', reqId: 92, title: 'Custom answer' } });
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
    const cancel = app.messages.findLast(message => String(message.text).includes('cancel here'))!;
    const cancelMarkup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(cancel.reply_markup);
    app.disconnect();
    await app.callback(cancelMarkup.inline_keyboard[0]![0]!.callback_data, cancel);
    assert.equal(app.accepted.filter(frame => frame.t === 'ui-response').length, count);
  } finally { await app.close(); }
});

test('cancel dismisses a pending custom response without submitting a prompt', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Start' });
    app.emit({ t: 'ui-request', request: { kind: 'editor', reqId: 101, title: 'Enter custom response' } });
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
    const cancel = app.messages.findLast(message => String(message.text).includes('cancel here'))!;
    const { inline_keyboard } = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(cancel.reply_markup);
    const before = app.accepted.length;
    await app.callback(inline_keyboard[0]![0]!.callback_data, cancel);
    assert.deepEqual(app.accepted.slice(before), [{ t: 'ui-response', reqId: 101, value: undefined }]);
    await eventually(() => cancel.text === 'Question cancelled.');
  } finally { await app.close(); }
});

test('a long selected option stays visible across Unicode-safe receipt chunks', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Start' });
    const label = 'Custom deployment <literal> 😀 '.repeat(200) + 'end-of-selection';
    app.emit({ t: 'ui-request', request: { kind: 'select', reqId: 111, title: 'Select a deployment', options: ['Default', label] } });
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('ask:')));
    const question = app.messages.at(-1)!;
    const { inline_keyboard } = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(question.reply_markup);
    await app.callback(inline_keyboard[0]![1]!.callback_data, question);
    app.emit({t:'ui-request-end',reqId:111});
    await eventually(() => app.messages.some(message => String(message.text).endsWith('end-of-selection') && message.reply_parameters));
    const receipt = [question, ...app.messages.filter(message =>
      z.object({message_id:z.number()}).safeParse(message.reply_parameters).data?.message_id === question.message_id)];
    const receiptText = receipt.map(message => message.text).join('');
    assert.ok(receiptText.includes(label));
    assert.ok(receiptText.includes('2️⃣'));
    assert.deepEqual(question.reply_markup, {inline_keyboard:[]});
    for (const message of receipt) {
      assert.ok(String(message.text).length <= 4000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(String(message.text)));
      assert.equal(message.parse_mode, undefined);
    }
  } finally { await app.close(); }
});

test('Telegram rate limits retain the answer receipt and following custom-answer prompt', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    const session = app.store.listSessions(botId)[0]!;
    app.emit({t:'ui-request',request:{kind:'select',reqId:121,title:'Choose deployment',options:['Default','Other (type your own)']}});
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('ask:')));
    const control = app.messages.at(-1)!;
    const {inline_keyboard} = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(control.reply_markup);
    app.rateLimitNext('editMessageText');
    app.rateLimitNext('sendMessage');
    await app.callback(inline_keyboard[0]![1]!.callback_data,control);
    app.emit({t:'ui-request',request:{kind:'editor',reqId:122,title:'Custom deployment target'}});
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
    assert.ok(String(control.text).includes('Other (type your own)'));
    assert.deepEqual(control.reply_markup,{inline_keyboard:[]});
    const editor = app.messages.at(-1)!;
    const text = 'Private staging\n  Preserve this target  ';
    await app.update({message_thread_id:session.threadId,text,reply_to_message:{message_id:editor.message_id,from:{id:botId,is_bot:true,first_name:'OMP'}}});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'ui-response'),[
      {t:'ui-response',reqId:121,value:'Other (type your own)'},
      {t:'ui-response',reqId:122,value:text},
    ]);
  } finally { await app.close(); }
});

test('a host-ended rate-limited question is not retried into a stale keyboard', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    app.rateLimitNext('sendMessage');
    const rejected = once(app.events,'rate-limit');
    app.emit({t:'ui-request',request:{kind:'select',reqId:131,title:'Already ended question',options:['Stale answer']}});
    await rejected;
    app.emit({t:'ui-request-end',reqId:131});
    app.emit({t:'ui-request',request:{kind:'select',reqId:132,title:'Current question',options:['Current answer']}});
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('ask:')));
    assert.ok(!app.messages.some(message => String(message.text).includes('Already ended question')));
    assert.ok(app.messages.some(message => String(message.text).includes('Current answer')));
    const control = app.messages.at(-1)!;
    const {inline_keyboard} = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(control.reply_markup);
    await app.callback(inline_keyboard[0]![0]!.callback_data,control);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'ui-response'),[{t:'ui-response',reqId:132,value:'Current answer'}]);
  } finally { await app.close(); }
});

test('an immediate host UI completion acknowledges the custom-answer message, not the editor prompt', async () => {
  const app = await createSmokeApp({ackUiResponses:true});
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    const session = app.store.listSessions(botId)[0]!;
    app.emit({t:'ui-request',request:{kind:'editor',reqId:141,title:'Enter a custom answer'}});
    await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
    const editor = app.messages.at(-1)!;
    await app.update({message_id:8300,message_thread_id:session.threadId,text:'Custom answer 😀',reply_to_message:{message_id:editor.message_id,from:{id:botId,is_bot:true,first_name:'OMP'}}});
    await eventually(() => app.reactions.some(reaction => reaction.message_id === 8300 && JSON.stringify(reaction.reaction).includes('🤝')));
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 8300).map(reaction => reaction.reaction),[
      [{type:'emoji',emoji:'👀'}],[{type:'emoji',emoji:'🤝'}],
    ]);
    assert.ok(!app.reactions.some(reaction => reaction.message_id === editor.message_id));
  } finally { await app.close(); }
});

for (const outcome of ['error','stop','disconnect'] as const) {
  test(`a custom answer does not receive agent acknowledgment after ${outcome}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Start'});
      const session = app.store.listSessions(botId)[0]!;
      app.emit({t:'ui-request',request:{kind:'editor',reqId:151,title:'Pending custom answer'}});
      await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
      const editor = app.messages.at(-1)!;
      await app.update({message_id:8400,message_thread_id:session.threadId,text:'Pending answer',reply_to_message:{message_id:editor.message_id,from:{id:botId,is_bot:true,first_name:'OMP'}}});
      if (outcome === 'error') app.emit({t:'error',message:'UI response rejected'});
      else if (outcome === 'stop') await app.update({message_thread_id:session.threadId,text:'/stop'});
      else app.disconnect();
      app.emit({t:'ui-request-end',reqId:151});
      await app.update({text:'/status'});
      assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 8400).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    } finally { await app.close(); }
  });
}
