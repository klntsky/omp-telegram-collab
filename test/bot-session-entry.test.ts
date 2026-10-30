import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

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

test('reconciliation admits pending initial tasks without eagerly launching other topics', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const instancePath = Object.keys(app.config.instances)[0]!;
    app.store.createSession({botId,chatId,threadId:42,instancePath},'Empty topic');
    const pending = app.store.createSession({botId,chatId,threadId:43,instancePath},'Pending topic',{kind:'managed'},'Restore pending task',123,undefined,ownerId);
    await app.service.reconcileConfiguration();
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
    app.disconnect();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Preserve unsent task'}]);
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
  } finally {
    await app.close();
  }
});

