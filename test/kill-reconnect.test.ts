import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';
import { Bot } from 'grammy';
import { createBot, type BotService } from '../src/bot.js';

async function setup() {
  const app = await createSmokeApp();
  await app.update({text:'/setup'});
  await app.update({message_thread_id:42,forum_topic_created:{name:'Reconnect fence'}});
  const session = app.store.listSessions(botId)[0]!;
  const authorize = (generation?: number) => fetch(`${app.url}/api/session`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id),generation}),
  });
  return {app,session,authorize};
}

test('a disconnected Mini App cannot refresh or use a pre-kill ticket to respawn the host', async () => {
  const {app,session,authorize} = await setup();
  let socket: WebSocket | undefined;
  try {
    const initial = await (await authorize()).json() as {ticket:string;generation:number};
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    // No socket exists to receive the terminal close frame.
    await app.update({message_thread_id:42,text:'/kill'});
    const retry = await authorize(initial.generation);
    assert.equal(retry.status,409,'automatic refresh from a pre-kill page must be terminal');
    socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${initial.ticket}`,{origin:app.config.publicUrl});
    let opened = false;
    socket.on('open',() => { opened = true; });
    await once(socket,'error');
    assert.equal(opened,false,'a pre-kill ticket must not reach an upgraded connection');
    socket.terminate();
    assert.equal(await app.runtime.isRunning(session),false);
    const fresh = await (await authorize()).json() as {ticket:string;generation:number};
    assert.notEqual(fresh.generation,initial.generation,'explicit rejoin obtains the current generation');
    socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${fresh.ticket}`,{origin:app.config.publicUrl});
    const ready = Promise.withResolvers<void>();
    socket.on('message',data => {
      const frame = JSON.parse(data.toString());
      if (frame.t === 'snapshot-chunk' && frame.final) ready.resolve();
    });
    await ready.promise;
    assert.equal(await app.runtime.isRunning(session),true,'an explicit fresh join may resume the saved session');
    assert.equal((await authorize(initial.generation)).status,409,'old pages remain revoked after a fresh join');
  } finally {
    socket?.terminate();
    await app.close();
  }
});

test('kill fences a ticket refresh already awaiting membership authorization', async t => {
  const {app,session,authorize} = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const initial = await (await authorize()).json() as {generation:number};
    const original = app.service.authorizeSession.bind(app.service);
    let blockNext = true;
    t.mock.method(app.service,'authorizeSession',async (...args: Parameters<typeof original>) => {
      if (blockNext) {
        blockNext = false;
        entered.resolve();
        await release.promise;
      }
      return original(...args);
    });
    const refreshing = authorize(initial.generation);
    await entered.promise;
    await app.update({message_thread_id:42,text:'/kill'});
    release.resolve();
    assert.equal((await refreshing).status,409);
    assert.equal(await app.runtime.isRunning(session),false);
  } finally {
    release.resolve();
    await app.close();
  }
});

for (const blockAt of [1,2]) {
  test(`kill fences an in-flight WebSocket ${blockAt === 1 ? 'upgrade' : 'host admission'}`, async t => {
    const {app,session,authorize} = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let socket: WebSocket | undefined;
    try {
      const initial = await (await authorize()).json() as {ticket:string};
      const original = app.service.authorizeSession.bind(app.service);
      let calls = 0;
      t.mock.method(app.service,'authorizeSession',async (...args: Parameters<typeof original>) => {
        if (++calls === blockAt) {
          entered.resolve();
          await release.promise;
        }
        return original(...args);
      });
      socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${initial.ticket}`,{origin:app.config.publicUrl});
      const closed = Promise.withResolvers<void>();
      socket.on('error',() => {});
      socket.once('close',() => closed.resolve());
      await entered.promise;
      await app.update({message_thread_id:42,text:'/kill'});
      release.resolve();
      await closed.promise;
      assert.equal(await app.runtime.isRunning(session),false);
      assert.equal(app.connectionCount,0,'no host or mirror may be admitted by a stale reconnect');
    } finally {
      release.resolve();
      socket?.terminate();
      await app.close();
    }
  });
}

for (const source of ['startup','mirror retry']) {
  test(`kill fences a background ${source} liveness check`, async t => {
    const {app,session} = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    let restarted: BotService | undefined;
    try {
      await app.service.ensureMirroring(session,await app.runtime.ensure(session));
      const original = app.runtime.isRunning.bind(app.runtime);
      let blockNext = source === 'startup';
      t.mock.method(app.runtime,'isRunning',async (value: Parameters<typeof original>[0]) => {
        if (blockNext) {
          blockNext = false;
          entered.resolve();
          return release.promise;
        }
        return original(value);
      });
      if (source === 'startup') {
        restarted = createBot({
          config:app.config,botConfig:app.config.bots[0]!,token:app.service.token,
          store:app.store,runtime:app.runtime,
          bot:new Bot(app.service.token,{client:{apiRoot:app.telegramUrl}}),
        });
        await restarted.initialize();
        restarted.startBackground();
      }
      else {
        app.disconnect();
        blockNext = true;
      }
      await entered.promise;
      const connections = app.connectionCount;
      await app.update({message_thread_id:42,text:'/kill'});
      release.resolve(true);
      await delay(100);
      assert.equal(await app.runtime.isRunning(session),false);
      assert.equal(app.connectionCount,connections,'stale liveness results must not restart mirroring or its host');
    } finally {
      release.resolve(false);
      await restarted?.close();
      await app.close();
    }
  });
}
