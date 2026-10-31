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
    assert.equal(app.messages.length, 1, 'the recovered update is handled exactly once');
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
    const initialStart = app.messages.length;
    answer(1, 'Initial answer');
    await eventually(() => app.messages.length > initialStart);
    assert.deepEqual(app.messages.at(-1)?.reply_parameters, { message_id: 2001, allow_sending_without_reply: true });

    await app.update({ message_id: 2002, message_thread_id: session.threadId, text: '@FixtureOmpBot First follow-up', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    const before = app.messages.length;
    answer(2, 'a'.repeat(65537));
    await app.update({ message_id: 2003, message_thread_id: session.threadId, text: '@FixtureOmpBot Second follow-up', entities: [{ type: 'mention', offset: 0, length: 14 }] });
    await eventually(() => app.messages.length >= before + 3);
    const chunks = app.messages.slice(before);
    assert.ok(chunks.every(message => message.message_thread_id === session.threadId));
    assert.deepEqual(chunks.map(message => message.reply_parameters), Array.from({ length: 3 }, () => ({ message_id: 2002, allow_sending_without_reply: true })));

    const formattedStart = app.messages.length;
    const markdown = '# Report\n\n| Component | Status |\n| --- | --- |\n| **Gateway** | Ready |\n\n$x^2$';
    answer(5, markdown);
    await eventually(() => app.messages.length >= formattedStart + 1);
    const formatted = app.messages.slice(formattedStart);
    assert.ok(formatted.every(message => message.message_thread_id === session.threadId));
    assert.deepEqual(formatted.map(message => message.reply_parameters), [{ message_id: 2003, allow_sending_without_reply: true }]);

    await app.update({ message_id: 2004, message_thread_id: session.threadId, text: 'Plain-text follow-up' });
    const plainStart = app.messages.length;
    answer(3, 'Plain-text follow-up answer');
    await eventually(() => app.messages.length > plainStart);
    assert.deepEqual(app.messages.at(-1)?.reply_parameters, { message_id: 2004, allow_sending_without_reply: true });

    app.emit({ t: 'entry', entry: {
      type: 'custom_message', id: 'web-prompt', parentId: null, timestamp: new Date(4).toISOString(),
      customType: 'collab-prompt', content: 'Instruction from the Mini App', details: { from: 'Web participant' }, display: true,
    } });
    const webStart = app.messages.length;
    answer(4, 'Mini App answer');
    await eventually(() => app.messages.length > webStart);
    assert.equal(app.messages.at(-1)?.reply_parameters, undefined);
  } finally {
    await app.close();
  }
});

test('agent replies follow acknowledged inputs rather than newer submissions', { timeout: 15_000 }, async () => {
  const app = await createSmokeApp({ holdPromptReceipts: true, skipStartupRejection: true });
  const acknowledge = (text: string, id: number) => {
    app.emit({
      t: 'entry',
      entry: {
        type: 'custom_message',
        id: `receipt-${id}`,
        parentId: null,
        timestamp: new Date(id).toISOString(),
        customType: 'collab-prompt',
        content: text,
        details: { from: 'Telegram @FixtureOmpBot' },
        display: true,
      },
    });
  };
  const reply = async (id: number) => {
    const before = app.messages.length;
    app.emit({
      t: 'entry',
      entry: {
        type: 'message',
        id: `held-receipt-answer-${id}`,
        parentId: null,
        timestamp: new Date(id).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Answer ${id}` }],
          model: 'fixture',
          timestamp: id,
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
      },
    });
    await eventually(() =>
      app.messages.slice(before).some(message => message.rich_message !== undefined),
    );
    return app.messages.slice(before).find(message => message.rich_message !== undefined)!;
  };
  try {
    await app.update({ text: '/setup' });
    await app.update({ message_id: 6001, text: '/new Initial task' });
    const session = app.store.listSessions(botId)[0]!;
    assert.equal((await reply(1)).reply_parameters, undefined);

    acknowledge('Initial task', 1);
    await eventually(() =>
      app.reactions.some(reaction =>
        reaction.message_id === 6001 && JSON.stringify(reaction.reaction).includes('🤝'),
      ),
    );
    await app.update({
      message_id: 6002,
      message_thread_id: session.threadId,
      text: '/p Not yet accepted',
    });
    assert.deepEqual((await reply(2)).reply_parameters, {
      message_id: 6001,
      allow_sending_without_reply: true,
    });

    app.emit({ t: 'error', message: 'Fixture rejected the pending prompt' });
    await app.update({
      message_id: 6003,
      message_thread_id: session.threadId,
      text: '/p Accepted follow-up',
    });
    acknowledge('Accepted follow-up', 2);
    await eventually(() =>
      app.reactions.some(reaction =>
        reaction.message_id === 6003 && JSON.stringify(reaction.reaction).includes('🤝'),
      ),
    );
    assert.deepEqual((await reply(3)).reply_parameters, {
      message_id: 6003,
      allow_sending_without_reply: true,
    });
  } finally {
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
    }
    await eventually(() => frames.some(frame => frame.state?.queuedMessageCount === 220) || socket!.readyState !== WebSocket.OPEN);
    assert.equal(socket.readyState, WebSocket.OPEN, 'membership checks must not starve live output');
    assert.deepEqual(frames.filter(frame => frame.t === 'state').map(frame => frame.state?.queuedMessageCount), Array.from({ length: 220 }, (_, index) => index + 1));
  } finally {
    socket?.terminate();
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
    app.emit({t:'entry',entry:{type:'message',id:'mirrored-mini-app-answer',parentId:null,timestamp:new Date().toISOString(),message:{
      role:'assistant',content:[{type:'text',text:'Mirrored Mini App answer'}],model:'fixture',timestamp:Date.now(),
      stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},
    }}});
    await eventually(() => app.messages.some(message => message.message_thread_id === session.threadId && message.rich_message !== undefined));
    assert.equal(app.messages.at(-1)?.message_thread_id,session.threadId);
    assert.deepEqual(app.accepted,[]);
  } finally {
    await app.close();
  }
});
