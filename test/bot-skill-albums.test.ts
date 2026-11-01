import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId } from './telegram-data.js';

for (const general of [false,true]) {
  test(`image albums consume skills once and preserve all images in ${general ? 'General initial tasks' : 'session prompts'}`, {timeout:15000}, async t => {
    const app = await createSmokeApp();
    const bytes = Buffer.from('album-image').toString('base64');
    app.mockFiles(t, bytes);
    const downloads = app.fileRequests;
    try {
      await app.update({text:'/setup'});
      const seed = once(app.events,'accepted');
      await app.update({text:'/new Seed'});
      await seed;
      const threadId = general ? 1 : app.store.listSessions(botId)[0]!.threadId;
      await app.update({text:'/skill_pdf_tools',message_thread_id:threadId});
      await app.update({message_id:8001,message_thread_id:threadId,media_group_id:'album',photo:[{file_id:'first',file_unique_id:'first',width:100,height:100}]});
      await app.update({message_id:8002,message_thread_id:threadId,media_group_id:'album',photo:[{file_id:'second',file_unique_id:'second',width:100,height:100}],caption:`${general ? '/new' : '/p'} Inspect both`,reply_to_message:{message_id:7999,text:'Quoted context'}});
      assert.equal(app.accepted.filter(frame=>frame.t==='prompt').length,1);
      const submitted = once(app.events,'accepted');
      await submitted;
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{
        t:'prompt',text:'/skill:pdf-tools\n\n> Quoted context\n\nInspect both',
        images:[{type:'image',data:bytes,mimeType:'image/jpeg'},{type:'image',data:bytes,mimeType:'image/jpeg'}],
      });
      assert.deepEqual(downloads,['first','second']);
      const session = general
        ? app.store.listSessions(botId).find(session => session.threadId !== threadId && session.name !== 'Seed')!
        : app.store.listSessions(botId).find(session => session.threadId === threadId)!;
      const binding = await app.runtime.ensure(session);
      const expected = {ompSessionId:binding.sessionId,entryId:`accepted-${app.accepted.length}`,parentEntryId:null,kind:'collab-prompt',partIndex:0};
      for (const messageId of [8001,8002])
        assert.deepEqual(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, messageId), expected);
      if (general)
        for (const forwarded of app.messages.filter(message => [8001,8002].includes(Number(message.forwarded_message_id))))
          assert.deepEqual(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, Number(forwarded.message_id)), expected);
      assert.equal(app.store.getMessageAnchor(session.id, binding.sessionId, chatId, 7999), undefined);
      await app.update({text:'/p Next',message_thread_id:threadId});
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt').at(-1),{t:'prompt',text:'Next'});
    } finally {
      await app.close();
    }
  });
}

for (const general of [false,true]) {
  test(`image-only albums preserve empty text and every image in ${general ? 'initial tasks' : 'session prompts'}`, {timeout:15000}, async t => {
    const app = await createSmokeApp();
    const bytes = Buffer.from('image-only-album').toString('base64');
    app.mockFiles(t, bytes);
    try {
      await app.update({text:'/setup'});
      const seed = once(app.events,'accepted');
      await app.update({text:'/new Seed'});
      await seed;
      const threadId = general ? 1 : app.store.listSessions(botId)[0]!.threadId;
      await app.update({message_id:8101,message_thread_id:threadId,media_group_id:'image-only-album',photo:[{file_id:'first',file_unique_id:'first',width:100,height:100}]});
      await app.update({message_id:8102,message_thread_id:threadId,media_group_id:'image-only-album',photo:[{file_id:'second',file_unique_id:'second',width:100,height:100}],...(general ? {caption:'/new'} : {})});
      assert.equal(app.accepted.filter(frame=>frame.t==='prompt').length,1);
      const submitted = once(app.events,'accepted');
      await submitted;
      assert.deepEqual(app.accepted.filter(frame=>frame.t==='prompt'),[
        {t:'prompt',text:'Seed'},
        {t:'prompt',text:'',images:[{type:'image',data:bytes,mimeType:'image/jpeg'},{type:'image',data:bytes,mimeType:'image/jpeg'}]},
      ]);
      assert.deepEqual(app.fileRequests,['first','second']);
      if (general) {
        const session = app.store.listSessions(botId).find(session=>session.name!=='Seed')!;
        assert.ok(session);
        assert.equal(app.store.hasPendingInitialTask(session.id),false);
      }
    } finally {
      await app.close();
    }
  });
}
