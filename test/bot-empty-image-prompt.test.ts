import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId } from './telegram-data.js';
import { eventually } from './bot-test-helpers.js';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const photo = [{file_id:'photo',file_unique_id:'photo',width:100,height:100}];

test('image-only commands preserve empty text through new-topic admission and session submission', async t => {
  const app = await createSmokeApp();
  app.mockFiles(t,data);
  try {
    await app.update({text:'/setup'});
    await app.update({photo,caption:'/p'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), [{
      t:'prompt',text:'',images:[{type:'image',data,mimeType:'image/jpeg'}],
    }]);
    await app.update({message_thread_id:session.threadId,document:{file_id:'document',file_unique_id:'document',mime_type:'image/png'},caption:'/p'});
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1), {
      t:'prompt',text:'',images:[{type:'image',data,mimeType:'image/png'}],
    });
  } finally { await app.close(); }
});
