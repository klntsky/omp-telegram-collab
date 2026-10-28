import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

for (const [source, threadId, text] of [
  ['/new in General', undefined, '/new Create a session'],
  ['/new in a topic', 42, '/new Create another session'],
  ['interactive /new', 42, 'Create an interactive session'],
  ['/attach', undefined, '/attach local-instance Attached session'],
] as const) {
  test(`${source} replies to the creating message with the topic link before host startup`, async () => {
    const app = await createSmokeApp();
    let messagesAtStartup: Record<string, unknown>[] = [];
    app.runtime.ensure = async () => {
      messagesAtStartup = [...app.messages];
      throw new Error('Host startup failed');
    };
    try {
      await app.update({ text: '/setup' });
      let replyTo: Record<string, unknown> | undefined;
      if (source === 'interactive /new') {
        await app.update({ text: '/new', message_thread_id: threadId });
        replyTo = app.messages.at(-1)!;
      }
      await app.update({
        message_id: 7001, text, message_thread_id: threadId,
        ...(replyTo ? { reply_to_message: replyTo } : {}),
      });
      const session = app.store.listSessions(botId)[0]!;
      const reply = messagesAtStartup.find(message =>
        (message.reply_parameters as { message_id?: number } | undefined)?.message_id === 7001);
      assert.ok(reply, 'the creator can navigate to the topic even if its host fails to start');
      assert.equal(reply.chat_id, chatId);
      assert.equal(reply.message_thread_id, threadId);
      assert.equal(reply.text, `Topic created: https://t.me/c/1234567890/${session.threadId}`);
    } finally {
      await app.close();
    }
  });
}

for (const [source, message] of [
  ['manual topic', { message_thread_id: 42, forum_topic_created: { name: 'Manual session', icon_color: 7322096 } }],
  ['/new', { text: '/new Start a session' }],
  ['/attach', { text: '/attach local-instance Attached session' }],
] as const) {
  test(`${source} pins the session button before host startup, even when startup fails`, async () => {
    const app = await createSmokeApp();
    let pinsAtStartup: Record<string, unknown>[] = [];
    app.runtime.ensure = async () => {
      pinsAtStartup = [...app.pins];
      throw new Error('Host startup failed');
    };
    try {
      await app.update({ text: '/setup' });
      await app.update(message);
      const session = app.store.listSessions(botId)[0]!;
      if (source === '/new') assert.equal(app.createdTopics[0]?.icon_custom_emoji_id,'5312016608254762256');
      if (source === 'manual topic') {
        assert.equal(pinsAtStartup.length,0,'creating an empty topic must not launch a host');
        await app.update({ message_thread_id: session.threadId, text: '@FixtureOmpBot Start coding', entities: [{ type: 'mention', offset: 0, length: 14 }] });
      }
      const announcement = app.messages.find(value => value.message_thread_id === session.threadId && value.reply_markup);
      assert.ok(announcement, 'the session entry remains available when the host cannot start');
      assert.deepEqual(announcement.reply_markup, {
        inline_keyboard: [[{ text: 'Open Session', url: `https://t.me/FixtureOmpBot/app?startapp=s_${session.id}` }]],
      });
      assert.deepEqual(pinsAtStartup, [{ chat_id: session.chatId, message_id: announcement.message_id, disable_notification: true }]);
      const before = app.messages.length;
      await app.update({ message_thread_id: session.threadId, forum_topic_created: { name: session.name, icon_color: 7322096 } });
      assert.equal(app.messages.length, before, 'duplicate service events do not repost the session entry');
      assert.deepEqual(app.pins, pinsAtStartup);
    } finally {
      await app.close();
    }
  });
}

for (const failure of [
  new Error('Host 🚫 could not start: <socket> & `token`\nECONNREFUSED 127.0.0.1:3000'),
  'Local service unavailable',
]) {
  test(`operation failures expose literal code-block details for ${typeof failure} rejections`, async () => {
    const app = await createSmokeApp();
    app.runtime.ensure = async () => { throw failure; };
    try {
      await app.update({ text: '/setup' });
      await app.update({ text: '/new Start a session' });
      const reply = app.messages.at(-1)!;
      const details = failure instanceof Error ? failure.message : failure;
      const text = String(reply.text);
      const entities = reply.entities as { type: string; offset: number; length: number }[];
      assert.ok(text.endsWith(details));
      assert.equal(reply.parse_mode, undefined);
      assert.deepEqual(entities, [{ type: 'pre', offset: text.length - details.length, length: details.length }]);
      assert.equal(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length), details);
    } finally {
      await app.close();
    }
  });
}

test('enrollment requires permission to pin the session entry', async () => {
  const app = await createSmokeApp({ botCanPinMessages: false });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Cannot pin this session' });
    assert.equal(app.store.isEnrolled(botId, chatId), false);
    assert.deepEqual(app.store.listSessions(botId), []);
  } finally {
    await app.close();
  }
});

test('another participant starting work does not cancel an explicitly rejected initial task', async () => {
  const app = await createSmokeApp({ competingStartAfterRejection: true });
  try {
    await app.update({ text: '/setup' });
    await app.update({ text: '/new Preserve this task' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Preserve this task' }]);
  } finally {
    await app.close();
  }
});

test('initialization admits pending initial tasks without eagerly launching other topics', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    app.store.createSession({botId,chatId,threadId:42,instancePath},'Empty topic');
    const pending = app.store.createSession({botId,chatId,threadId:43,instancePath},'Pending topic',{kind:'managed'},'Restore pending task',123);
    await app.service.initialize();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Restore pending task'}]);
    assert.equal(app.connectionCount,1);
    assert.equal(app.store.hasPendingInitialTask(pending.id),false);
  } finally {
    await app.close();
  }
});

test('retirement admission rejection preserves an unsent initial task for the next listener attempt', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const fence = t.mock.method(app.runtime,'markPrompt',() => { throw new Error('Host is retiring'); });
    await app.update({text:'/new Preserve unsent task'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.accepted.length,0);
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    fence.mock.restore();
    await app.service.initialize();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Preserve unsent task'}]);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
  } finally {
    await app.close();
  }
});

for (const interactive of [false,true]) {
  test(`${interactive ? 'interactive /new' : '/new task'} forwards the original message below the session entry exactly once`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const task = 'Review <literal> auth\nKeep the original formatting 😀';
      if (interactive) {
        await app.update({text:'/new'});
        const request = app.messages.at(-1)!;
        await app.update({message_id:7002,text:task,reply_to_message:{message_id:request.message_id}},{
          id:ownerId,first_name:'No',last_name:'Username',is_bot:false,
        });
      } else {
        await app.update({message_id:7002,text:`/new ${task}`});
      }
      const session = app.store.listSessions(botId)[0]!;
      const topicMessages = app.messages.filter(message => message.message_thread_id === session.threadId);
      assert.ok(topicMessages[0]?.reply_markup,'the session entry remains first');
      assert.equal(topicMessages[1]?.from_chat_id,chatId);
      assert.equal(topicMessages[1]?.forwarded_message_id,7002);
      assert.equal(topicMessages[1]?.text,undefined,'the original message is forwarded, not rewritten with attribution');
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:task}],'the visible copy is not a second submission');
    } finally {
      await app.close();
    }
  });
}
