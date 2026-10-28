import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now()+4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Kill completion reaction did not arrive');
    await delay(20);
  }
}

test('/kill keeps eyes while termination is pending and acknowledges only after successful exit', async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const kill = app.runtime.kill.bind(app.runtime);
  app.runtime.kill = async session => { entered.resolve(); await release.promise; await kill(session); };
  let updating: Promise<void> | undefined;
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    const session = app.store.listSessions(botId)[0]!;
    updating = app.update({message_id:9101,message_thread_id:session.threadId,text:'/kill'});
    await entered.promise;
    assert.equal(await app.runtime.isRunning(session),true);
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9101).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    release.resolve();
    await updating;
    await eventually(() => app.reactions.some(reaction => reaction.message_id === 9101 && JSON.stringify(reaction.reaction).includes('🤝')));
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.store.getSession(session.id)?.id,session.id);
    assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9101).map(reaction => reaction.reaction),[
      [{type:'emoji',emoji:'👀'}],[{type:'emoji',emoji:'🤝'}],
    ]);
  } finally { release.resolve(); await updating?.catch(() => undefined); await app.close(); }
});

for (const outcome of ['failed','denied'] as const) {
  test(`a ${outcome} /kill never receives a completion reaction`, async () => {
    const app = await createSmokeApp();
    let attempts = 0;
    app.runtime.kill = async () => { attempts++; throw new Error('Process identity could not be verified'); };
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Start'});
      const session = app.store.listSessions(botId)[0]!;
      if (outcome === 'denied') app.setMember(false);
      await app.update({message_id:9102,message_thread_id:session.threadId,text:'/kill'});
      assert.equal(attempts,outcome === 'denied' ? 0 : 1);
      assert.deepEqual(app.reactions.filter(reaction => reaction.message_id === 9102).map(reaction => reaction.reaction),[[{type:'emoji',emoji:'👀'}]]);
    } finally { await app.close(); }
  });
}
