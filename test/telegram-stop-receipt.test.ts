import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now()+4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Stop acknowledgment did not arrive');
    await delay(20);
  }
}

const notice = {type:'notice',level:'info',source:'collab',message:'Telegram @FixtureOmpBot interrupted'} as const;

test('/stop changes its own reaction only after the matching host interruption notice', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_id:9001,message_thread_id:session.threadId,text:'/stop'});
    assert.ok(app.accepted.some(frame => frame.t === 'abort'));
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9001).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    app.emit({t:'event',event:{...notice,source:'extension'}});
    app.emit({t:'event',event:{...notice,message:'@AnotherUser interrupted'}});
    await app.update({text:'/status'});
    assert.ok(!app.reactions.some(reaction => reaction.message_id === 9001 && JSON.stringify(reaction.reaction).includes('🤝')));
    app.emit({t:'event',event:notice});
    await eventually(() => app.reactions.some(reaction => reaction.message_id === 9001 && JSON.stringify(reaction.reaction).includes('🤝')));
    app.emit({t:'event',event:notice});
    await app.update({text:'/status'});
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9001).map(reaction => reaction.reaction),[
      [{type:'emoji',emoji:'👀'}],[{type:'emoji',emoji:'🤝'}],
    ]);
  } finally { await app.close(); }
});

test('/stop on an empty topic is seen but never claims that a nonexistent agent received it', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Idle topic'}});
    await app.update({message_id:9002,message_thread_id:42,text:'/stop'});
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9002).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    assert.ok(!app.accepted.some(frame => frame.t === 'abort'));
  } finally { await app.close(); }
});

test('/stop cannot be acknowledged by stale notices after errors or disconnects', async () => {
  for (const outcome of ['error','disconnect'] as const) {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Start'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      await app.update({message_id:9003,message_thread_id:session.threadId,text:'/stop'});
      if (outcome === 'error') app.emit({t:'error',message:'Abort rejected'});
      else app.disconnect();
      app.emit({t:'event',event:notice});
      await app.update({text:'/status'});
      assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9003).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    } finally { await app.close(); }
  }
});
