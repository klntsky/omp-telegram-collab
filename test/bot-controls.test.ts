import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';
import { capacityRequest, waitingForCapacity } from './bot-capacity-helpers.js';

for (const command of ['stop', 'kill']) {
  test(`/${command} is restricted to authorized instructions in the matching session topic`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Controlled topic'}});
      const session = app.store.listSessions(botId)[0]!;
      await app.service.ensureMirroring(session,await app.runtime.ensure(session));
      for (const message of [
        {text:`/${command}`},
        {text:`/${command}`,message_thread_id:1},
        {text:`/${command}`,message_thread_id:99},
        {text:`/${command}`,message_thread_id:42,chat:{id:123,type:'private'}},
        {text:`/${command}@AnotherBot`,message_thread_id:42},
        {text:`/${command}`,message_thread_id:42,forward_origin:{type:'hidden_user',date:1,sender_user_name:'Forwarder'}},
      ]) await app.update(message);
      app.setMember(false);
      await app.update({text:`/${command}`,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),true);
      assert.deepEqual(app.accepted,[]);
    } finally {
      await app.close();
    }
  });

  test(`/${command} cancels a waiting initial task without starting a host or approving stale capacity`, async () => {
    const app = await waitingForCapacity();
    try {
      const sessions = app.store.listSessions(botId);
      const running = sessions.find(session => session.name === 'Running task')!;
      const waiting = sessions.find(session => session.name === 'Waiting task')!;
      const request = capacityRequest(app,waiting.threadId);
      const connections = app.connectionCount;
      await app.update({text:`/${command}`,message_thread_id:waiting.threadId});
      await app.callback(request.approve,request.message);
      await app.service.initialize();
      assert.equal(app.store.hasPendingInitialTask(waiting.id),false);
      assert.equal(await app.runtime.isRunning(waiting),false);
      assert.equal(await app.runtime.isRunning(running),true);
      assert.equal(app.runtime.getSessionLimit(),1);
      assert.equal(app.connectionCount,connections);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Running task'}]);
    } finally {
      await app.close();
    }
  });

  test(`/${command} cancels startup retries but allows a later explicit instruction`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/new Rejected initial task'});
      const session = app.store.listSessions(botId)[0]!;
      await app.update({text:`/${command}@FixtureOmpBot`,message_thread_id:session.threadId});
      await delay(400);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
      assert.equal(await app.runtime.isRunning(session),command === 'stop');
      assert.equal(app.store.getSession(session.id)?.status,'open');
      await app.update({text:'@FixtureOmpBot Explicit next task',message_thread_id:session.threadId,entities:[{type:'mention',offset:0,length:14}]});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Explicit next task'}]);
      assert.equal(await app.runtime.isRunning(session),true);
      assert.equal(app.accepted.filter(frame => frame.t === 'abort').length,command === 'stop' ? 1 : 0);
    } finally {
      await app.close();
    }
  });
}

test('/stop on an empty topic does not launch its host', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Empty topic'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({text:'/stop',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),false);
    assert.equal(app.connectionCount,0);
    assert.deepEqual(app.accepted,[]);
  } finally {
    await app.close();
  }
});

test('/kill ends the matching Mini App connection without disconnecting other topics or reconnecting mirroring', async () => {
  const app = await createSmokeApp();
  const clients: WebSocket[] = [];
  try {
    await app.update({text:'/setup'});
    for (const threadId of [42,43]) await app.update({message_thread_id:threadId,forum_topic_created:{name:`Topic ${threadId}`}});
    const [target,other] = app.store.listSessions(botId);
    assert.ok(target && other);
    for (const session of [target,other]) {
      const response = await fetch(`${app.url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botId,sessionId:session.id,initData:app.initData(session.id)})});
      assert.equal(response.status,200);
      const {ticket} = await response.json() as {ticket:string};
      const socket = new WebSocket(`${app.url.replace('http:','ws:')}/api/socket?ticket=${ticket}`,{origin:app.config.publicUrl});
      clients.push(socket);
      const frames: HostFrame[] = [];
      socket.on('message',data => frames.push(JSON.parse(data.toString())));
      await once(socket,'open');
      await eventually(() => frames.some(frame => frame.t === 'snapshot-chunk'));
    }
    const connections = app.connectionCount;
    const closed = once(clients[0]!,'close');
    await app.update({text:'/kill',message_thread_id:target.threadId});
    const [code] = await closed;
    assert.equal(code,4003,'explicit termination must not trigger Mini App automatic reconnect');
    await delay(1100);
    assert.equal(app.connectionCount,connections,'Telegram mirroring must not resurrect a killed process');
    assert.equal(await app.runtime.isRunning(target),false);
    assert.equal(await app.runtime.isRunning(other),true);
    assert.equal(clients[1]!.readyState,WebSocket.OPEN);
    assert.equal(app.topicEdits.findLast(edit => edit.message_thread_id === target.threadId)?.icon_custom_emoji_id,'5408906741125490282');
    await app.update({text:'/kill',message_thread_id:target.threadId});
    assert.equal(app.connectionCount,connections,'repeated kill must not launch a process');
  } finally {
    for (const socket of clients) socket.terminate();
    await app.close();
  }
});
