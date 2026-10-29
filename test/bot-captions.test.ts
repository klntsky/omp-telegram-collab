import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerUsername } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

const photo = [{ file_id: 'photo', file_unique_id: 'photo', width: 100, height: 100 }];
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('caption commands submit downloaded images through initial startup rejection and retry', async t => {
  const app = await createSmokeApp();
  app.mockFiles(t, imageData);
  try {
    await app.update({ photo, caption: '/setup' });
    await app.update({ message_id: 7001, photo, caption: '/new@FixtureOmpBot Inspect this image' });
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{ t: 'prompt', text: 'Inspect this image', images: [{ type: 'image', data: imageData, mimeType: 'image/jpeg' }] }]);
    const session = app.store.listSessions(botId)[0]!;
    assert.ok(session);
    assert.ok(app.messages.some(message => message.message_thread_id === session.threadId && message.forwarded_message_id === 7001));
  } finally {
    await app.close();
  }
});

test('caption commands retain bot targeting and forwarded-message exclusions', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await app.update({ photo, caption: '/new@AnotherBot Ignore this' });
    await app.update({ photo, caption: '/new Ignore forwarded media', forward_origin: { type: 'hidden_user', sender_user_name: 'Someone', date: 1 } });
    assert.deepEqual(app.store.listSessions(botId), []);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), []);
  } finally {
    await app.close();
  }
});

test('session media follows prompt mode and preserves image document bytes', async t => {
  const app = await createSmokeApp();
  app.mockFiles(t, imageData, 'image/png');
  const downloads = app.fileRequests;
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const document = {file_id:'original',file_unique_id:'original',mime_type:'image/png',file_name:'picture.png'};
    await app.update({message_thread_id:session.threadId,document,caption:'What is funny about this picture?'});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1), {
      t:'prompt',text:'What is funny about this picture?',images:[{type:'image',data:imageData,mimeType:'image/png'}],
    });
    await app.update({text:'/setup'});
    await app.callback('setup:prompts:false',app.messages.at(-1)!);
    await app.update({message_thread_id:session.threadId,document,caption:'Ignored discussion'});
    assert.deepEqual(downloads,['original']);
    await app.update({message_thread_id:session.threadId,document,caption:'/p Explain it'});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1), {
      t:'prompt',text:'Explain it',images:[{type:'image',data:imageData,mimeType:'image/png'}],
    });
  } finally {
    await app.close();
  }
});

test('unapproved image proposals cannot reach the model', async t => {
  const app = await createSmokeApp();
  app.mockFiles(t, imageData);
  try {
    await app.update({text:'/setup'});
    await app.callback('setup:proposals:true',app.messages.at(-1)!);
    const proposer = {id:77,username:'participant',first_name:'Participant',is_bot:false};
    app.setCurrentMember({username:'participant',status:'member'});
    await app.update({photo,caption:'/new Review this'},proposer);
    const proposal = app.messages.at(-1)!;
    const markup = proposal.reply_markup as {inline_keyboard:{callback_data:string}[][]};
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    app.setCurrentMember({username:ownerUsername,status:'member'});
    await app.callback(markup.inline_keyboard[0]![0]!.callback_data,proposal);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{
      t:'prompt',text:'Review this',images:[{type:'image',data:imageData,mimeType:'image/jpeg'}],
    }]);
  } finally {
    await app.close();
  }
});

test('host admission failure retains image bytes for later reconciliation', async t => {
  const app = await createSmokeApp();
  app.mockFiles(t, imageData);
  try {
    await app.update({text:'/setup'});
    const startup = t.mock.method(app.runtime,'ensure',async () => { throw new Error('Host temporarily unavailable'); });
    await app.update({photo,caption:'/new Keep the image'});
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(session.id),true);
    startup.mock.restore();
    await app.service.reconcileConfiguration();
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{
      t:'prompt',text:'Keep the image',images:[{type:'image',data:imageData,mimeType:'image/jpeg'}],
    }]);
  } finally {
    await app.close();
  }
});

test('failed downloads preserve diagnostics and never submit a text-only task', async t => {
  const app = await createSmokeApp();
  const failure = new Error('Telegram file unavailable\nFILE_ID_INVALID');
  t.mock.method(app.bot.api,'getFile',async () => { throw failure; });
  try {
    await app.update({text:'/setup'});
    await app.update({photo,caption:'/new Inspect this'});
    assert.ok(String(app.messages.at(-1)?.text).endsWith(failure.message));
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
  } finally {
    await app.close();
  }
});

test('missing native file metadata cannot submit a text-only image task', async t => {
  const app = await createSmokeApp();
  t.mock.method(app.bot.api, 'getFile', async () => ({ file_id: 'photo', file_unique_id: 'photo' }));
  try {
    await app.update({ text: '/setup' });
    await app.update({ photo, caption: '/new Inspect this' });
    assert.ok(String(app.messages.at(-1)?.text).endsWith('Telegram image file path is unavailable'));
    assert.deepEqual(app.store.listSessions(botId), []);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), []);
  } finally { await app.close(); }
});

test('native file HTTP failures retain response diagnostics and never submit a text-only image task', async t => {
  const app = await createSmokeApp();
  const diagnostic = 'Telegram file unavailable\nOriginal storage diagnostic';
  app.mockFiles(t, Buffer.from(diagnostic).toString('base64'), 'text/plain', 503);
  try {
    await app.update({ text: '/setup' });
    await app.update({ photo, caption: '/new Inspect this' });
    assert.ok(String(app.messages.at(-1)?.text).endsWith(`Telegram image download failed: 503 Service Unavailable\n${diagnostic}`));
    assert.deepEqual(app.fileRequests, ['photo']);
    assert.deepEqual(app.store.listSessions(botId), []);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), []);
  } finally { await app.close(); }
});

test('captionless photos use the largest size in all-message sessions', async t => {
  const app = await createSmokeApp();
  app.mockFiles(t, imageData);
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/new Start'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    await app.update({message_thread_id:session.threadId,photo:[
      ...photo,{file_id:'largest',file_unique_id:'largest',width:1000,height:1000},
    ]});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1),{
      t:'prompt',text:'Describe this image.',images:[{type:'image',data:imageData,mimeType:'image/jpeg'}],
    });
    assert.deepEqual(app.fileRequests, ['largest']);
  } finally {
    await app.close();
  }
});
