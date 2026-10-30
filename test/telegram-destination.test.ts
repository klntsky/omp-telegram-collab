import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';

test('General aliases and callbacks route independently from topic destinations', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    for (const threadId of [undefined, 1]) {
      await app.update({text:'/skills', message_thread_id:threadId, is_topic_message:true});
      const picker = app.messages.at(-1)!;
      assert.equal(picker.message_thread_id, undefined);
      const markup = picker.reply_markup as {inline_keyboard:Array<Array<{callback_data?:string}>>};
      const select = markup.inline_keyboard.flat().find(button => button.callback_data?.startsWith('skills:add:'))!;
      assert.ok(select.callback_data);
      await app.callback(select.callback_data, picker);
      assert.equal(app.messages.at(-1)?.message_thread_id, undefined);
      await app.update({text:'/skills clear',message_thread_id:threadId,is_topic_message:true});
      assert.equal(app.messages.at(-1)?.message_thread_id, undefined);
    }
      await app.update({message_thread_id:42,is_topic_message:true,forum_topic_created:{name:'Routing isolation'}});
      await app.update({text:'/skills',message_thread_id:42,is_topic_message:true});
      assert.equal(app.messages.at(-1)?.message_thread_id,42);
  } finally {
    await app.close();
  }
});
