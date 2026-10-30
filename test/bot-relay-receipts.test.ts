import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

test('Telegram rate limits recover without shutting down the bot service', async () => {
  const app = await createSmokeApp({ pollingTransientFailure: true });
  const polled = once(app.events, 'poll');
  const running = app.service.start();
  try {
    const outcome = await Promise.race([polled.then(() => 'recovered'), running.then(() => 'stopped', () => 'failed')]);
    assert.equal(outcome, 'recovered');
  } finally {
    await app.close();
    await running.catch(() => undefined);
  }
});

test('native transport failure retries polling and shutdown acknowledges handled updates without replay', { timeout: 15_000 }, async () => {
  const app = await createSmokeApp({ pollingTransientFailure: 'transport' });
  app.store.enrollGroup(botId, chatId);
  app.queueUpdates({
    update_id: 700,
    message: {
      message_id: 700, date: 0,
      chat: { id: chatId, type: 'supergroup', title: 'Fixture project', is_forum: true },
      from: { id: ownerId, first_name: 'Ada', username: ownerUsername, is_bot: false },
      text: '/help',
    },
  });
  const polled = once(app.events, 'poll');
  const running = app.service.start();
  try {
    const outcome = await Promise.race([polled.then(() => 'recovered'), running.then(() => 'stopped', () => 'failed')]);
    assert.equal(outcome, 'recovered');
    await eventually(() => app.pollRequests.some(request => request.offset === 701));
    assert.equal(app.messages.filter(message => String(message.text).includes('/skills')).length, 1, 'the recovered update is handled exactly once');
    await app.service.close();
    await running;
    const acknowledgement = app.pollRequests.at(-1)!;
    assert.deepEqual(acknowledgement, { offset: 701, limit: 1, timeout: 0 });
    const polls = app.pollRequests.length;
    await delay(50);
    assert.equal(app.pollRequests.length, polls, 'shutdown cannot leave a polling retry behind');
  } finally {
    await app.close();
    await running.catch(() => undefined);
  }
});

test('a relay disconnect restores mirroring without replaying the admitted prompt', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Finish the task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const before = app.connectionCount;
    app.disconnect();
    const delivered = once(app.events, 'message');
    app.appendEntry({ type: 'message', id: 'missed-output', parentId: null, timestamp: new Date().toISOString(), message: {
      role: 'assistant', content: [{ type: 'text', text: 'Recovered output' }], model: 'fixture', timestamp: Date.now() + 10,
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    } });
    await eventually(() => app.connectionCount > before);
    await delivered;
    assert.deepEqual(app.messages.at(-1)?.rich_message, {markdown:'Recovered output'});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Finish the task' }]);
  } finally {
    await app.close();
  }
});

test('agent replies retain their triggering Telegram message across chunks and later prompts', async () => {
  const app = await createSmokeApp();
  const answer = (id: number, text: string) => app.emit({ t: 'entry', entry: {
    type: 'message', id: `answer-${id}`, parentId: null, timestamp: new Date(id).toISOString(),
    message: {
      role: 'assistant', content: [{ type: 'text', text }], model: 'fixture', timestamp: id,
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    },
  } });
  try {
    await app.update({ message_id: 2000, text: '/setup' });
    await app.update({ message_id: 2001, text: '/new Initial request' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    answer(1, 'Initial answer');
    await eventually(() => app.messages.some(message => JSON.stringify(message.rich_message) === JSON.stringify({markdown:'Initial answer'})));
    assert.deepEqual(app.messages.at(-1)?.reply_parameters, { message_id: 2001, allow_sending_without_reply: true });

    await app.update({ message_id: 2002, message_thread_id: session.threadId, text: '@FixtureOmpBot First follow-up', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    const before = app.messages.length;
    answer(2, 'a'.repeat(65537));
    await app.update({ message_id: 2003, message_thread_id: session.threadId, text: '@FixtureOmpBot Second follow-up', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    await eventually(() => app.messages.length >= before + 3);
    const chunks = app.messages.slice(before);
    assert.deepEqual(chunks.map(message => message.rich_message), [{markdown:'a'.repeat(32768)}, {markdown:'a'.repeat(32768)}, {markdown:'a'}]);
    assert.ok(chunks.every(message => message.message_thread_id === session.threadId));
    assert.deepEqual(chunks.map(message => message.reply_parameters), Array.from({ length: 3 }, () => ({ message_id: 2002, allow_sending_without_reply: true })));

    const formattedStart = app.messages.length;
    const markdown = '# Report\n\n| Component | Status |\n| --- | --- |\n| **Gateway** | Ready |\n\n$x^2$';
    answer(5, markdown);
    await eventually(() => app.messages.length >= formattedStart + 1);
    const formatted = app.messages.slice(formattedStart);
    assert.deepEqual(formatted.map(message => message.rich_message), [{markdown}]);
    assert.ok(formatted.every(message => message.parse_mode === undefined && message.message_thread_id === session.threadId));
    assert.deepEqual(formatted.map(message => message.reply_parameters), [{ message_id: 2003, allow_sending_without_reply: true }]);

    await app.update({ message_id: 2004, message_thread_id: session.threadId, text: 'Plain-text follow-up' });
    answer(3, 'Plain-text follow-up answer');
    await eventually(() => app.messages.some(message => JSON.stringify(message.rich_message) === JSON.stringify({markdown:'Plain-text follow-up answer'})));
    assert.deepEqual(app.messages.at(-1)?.reply_parameters, { message_id: 2004, allow_sending_without_reply: true });

    app.emit({ t: 'entry', entry: {
      type: 'custom_message', id: 'web-prompt', parentId: null, timestamp: new Date(4).toISOString(),
      customType: 'collab-prompt', content: 'Instruction from the Mini App', details: { from: 'Web participant' }, display: true,
    } });
    answer(4, 'Mini App answer');
    await eventually(() => app.messages.some(message => JSON.stringify(message.rich_message) === JSON.stringify({markdown:'Mini App answer'})));
    assert.equal(app.messages.at(-1)?.reply_parameters, undefined);
  } finally {
    await app.close();
  }
});

test('bot receipt is immediate, while only admitted instructions get agent receipt reactions', async () => {
  const app = await createSmokeApp();
  const admitted = () => app.reactions.filter(reaction => JSON.stringify(reaction.reaction).includes('🤝'));
  try {
    await app.update({text:'/setup'});
    await app.update({message_id:3001,text:'/new Initial instruction'});
    await eventually(() => admitted().length === 1);
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_id:3002,message_thread_id:session.threadId,text:'@FixtureOmpBot Follow-up',entities:[{type:'mention',offset:0,length:14}]});
    await app.update({message_id:3003,message_thread_id:session.threadId,text:'Reply instruction',reply_to_message:{message_id:4000,from:{id:botId,is_bot:true,first_name:'OMP'}}});
    await eventually(() => admitted().length === 3);
    await app.update({message_id:3004,message_thread_id:session.threadId,text:'Ordinary message received by the bot'});
    await eventually(() => admitted().some(reaction => reaction.message_id === 3004));
    app.rejectNextPrompt();
    const rejected = once(app.events,'message');
    await app.update({message_id:3005,message_thread_id:session.threadId,text:'@FixtureOmpBot Rejected instruction',entities:[{type:'mention',offset:0,length:14}]});
    await rejected;
    await app.update({message_id:3006,message_thread_id:session.threadId,text:'@FixtureOmpBot Accepted instruction',entities:[{type:'mention',offset:0,length:14}]});
    await eventually(() => admitted().some(reaction => reaction.message_id === 3006));
    assert.deepEqual(app.reactions.filter(reaction => JSON.stringify(reaction.reaction).includes('👀')).map(reaction => reaction.message_id),[3001,3002,3003,3004,3005,3006]);
    assert.deepEqual(admitted().map(reaction => reaction.message_id),[3001,3002,3003,3004,3006]);
    for (const id of [3001,3002,3003,3004,3006]) {
      assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === id).map(reaction => reaction.reaction),[
        [{type:'emoji',emoji:'👀'}],[{type:'emoji',emoji:'🤝'}],
      ]);
    }
  } finally { await app.close(); }
});

test('agent receipts exclude foreign prompts and replay, retaining distinct targets for identical instructions', async () => {
  const app = await createSmokeApp({holdPromptReceipts:true});
  const admitted = () => app.reactions.filter(reaction => JSON.stringify(reaction.reaction).includes('🤝'));
  const receipt = (id: string, text: string, from = 'Telegram @FixtureOmpBot') => ({
    type:'custom_message' as const,id,parentId:null,timestamp:new Date().toISOString(),
    customType:'collab-prompt',content:text,details:{from},display:true,
  });
  try {
    await app.update({text:'/setup'});
    await app.update({message_id:3101,text:'/new Initial instruction'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.reactions.map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    app.emit({t:'entry',entry:receipt('foreign','Initial instruction','Web participant')});
    app.emit({t:'snapshot-chunk',entries:[receipt('snapshot','Initial instruction')],final:true});
    assert.deepEqual(admitted(),[]);
    app.emit({t:'entry',entry:receipt('initial','Initial instruction')});
    await eventually(() => admitted().length === 1);
    const session = app.store.listSessions(botId)[0]!;
    for (const message_id of [3102,3103]) {
      await app.update({message_id,message_thread_id:session.threadId,text:'@FixtureOmpBot Same instruction',entities:[{type:'mention',offset:0,length:14}]});
    }
    assert.equal(admitted().length,1);
    app.emit({t:'entry',entry:receipt('first','Same instruction')});
    await eventually(() => admitted().length === 2);
    app.emit({t:'entry',entry:receipt('second','Same instruction')});
    await eventually(() => admitted().length === 3);
    assert.deepEqual(admitted().map(reaction => reaction.message_id),[3101,3102,3103]);
  } finally { await app.close(); }
});

test('bot receipt is delivered before a blocked host startup can receive the instruction', async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const ensure = app.runtime.ensure.bind(app.runtime);
  app.runtime.ensure = async session => {
    entered.resolve();
    await release.promise;
    return ensure(session);
  };
  let updating: Promise<void> | undefined;
  try {
    await app.update({text:'/setup'});
    updating = app.update({message_id:3201,text:'/new Wait for the host'});
    await entered.promise;
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 3201).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    assert.ok(!app.accepted.some(frame => frame.t === 'prompt'));
    release.resolve();
    await updating;
    await eventually(() => app.reactions.some(reaction => reaction.message_id === 3201 && JSON.stringify(reaction.reaction).includes('🤝')));
  } finally {
    release.resolve();
    await updating?.catch(() => undefined);
    await app.close();
  }
});

test('busy streaming delivers every state frame without starving live output', { timeout: 10_000 }, async () => {
  const app = await createSmokeApp({ authorizationDelayMs: 30 });
  let socket: WebSocket | undefined;
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_thread_id: 31, forum_topic_created: { name: 'Busy stream' } });
    const session = app.store.listSessions(botId)[0]!;
    const response = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, sessionId: session.id, initData: app.initData(session.id) }) });
    assert.equal(response.status, 200);
    const { ticket } = await response.json() as { ticket: string };
    socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
    const frames: { t: string; final?: boolean; state?: { queuedMessageCount: number } }[] = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk' && frame.final));
    const state = { cwd: '/fixture/project', isStreaming: true, participants: [] };
    for (let sequence = 1; sequence <= 220; sequence++) {
      app.emit({ t: 'state', state: { ...state, queuedMessageCount: sequence } });
      await delay(2);
    }
    await eventually(() => frames.some(frame => frame.state?.queuedMessageCount === 220) || socket!.readyState !== WebSocket.OPEN);
    assert.equal(socket.readyState, WebSocket.OPEN, 'membership checks must not starve live output');
    assert.deepEqual(frames.filter(frame => frame.t === 'state').map(frame => frame.state?.queuedMessageCount), Array.from({ length: 220 }, (_, index) => index + 1));
  } finally {
    socket?.terminate();
    await app.close();
  }
});

test('Mini App prompt relay names the authenticated sender and preserves Unicode without resubmission', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Relay topic',icon_color:7322096}});
    const session = app.store.listSessions(botId)[0]!;
    const before = app.messages.length;
    const prompt = 'a'.repeat(3973)+'😀'.repeat(2100)+'\n<literal>';
    await app.service.relayPrompt(session,{userId:123,username:'ada',displayName:'Ada'},prompt);
    const messages = app.messages.slice(before);
    assert.equal(messages.map(message => message.text).join(''),`@ada posted a prompt: ${prompt}`);
    assert.ok(messages.every(message => String(message.text).length <= 4000 && String(message.text).isWellFormed()));
    assert.ok(messages.every(message => message.message_thread_id === session.threadId && message.parse_mode === undefined));
    await app.service.relayPrompt(session,{userId:456,displayName:'No handle'},'Second prompt');
    assert.equal(app.messages.at(-1)?.text,'No handle (user ID 456) posted a prompt: Second prompt');
    assert.deepEqual(app.accepted,[]);
    assert.equal(app.connectionCount,0);
  } finally {
    await app.close();
  }
});

test('opening a lazy topic can establish Telegram mirroring without submitting instructions', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Mini App topic',icon_color:7322096}});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.connectionCount,0);
    const binding = await app.runtime.ensure(session);
    await app.service.ensureMirroring(session,binding);
    app.emit({t:'event',event:{type:'message_end',message:{
      role:'assistant',content:[{type:'text',text:'Mirrored Mini App answer'}],model:'fixture',timestamp:Date.now(),
      stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},
    }}});
    await eventually(() => app.messages.some(message => JSON.stringify(message.rich_message) === JSON.stringify({markdown:'Mirrored Mini App answer'})));
    assert.equal(app.messages.at(-1)?.message_thread_id,session.threadId);
    assert.deepEqual(app.accepted,[]);
  } finally {
    await app.close();
  }
});
