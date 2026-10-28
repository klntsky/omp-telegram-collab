import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';

for (const threadId of [undefined, 1]) {
  test(`General routing survives topic metadata and callbacks (${threadId ?? 'omitted'})`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({text:'/skills', message_thread_id:threadId, is_topic_message:true});
      const picker = app.messages.at(-1)!;
      assert.match(String(picker.text), /Choose skills/);
      assert.equal(picker.message_thread_id, undefined);
      const markup = picker.reply_markup as {inline_keyboard:Array<Array<{callback_data?:string}>>};
      const select = markup.inline_keyboard.flat().find(button => button.callback_data?.startsWith('skills:add:'))!;
      assert.ok(select.callback_data);
      await app.callback(select.callback_data, picker);
      assert.match(String(app.messages.at(-1)?.text), /Your next message will mention/);
      assert.equal(app.messages.at(-1)?.message_thread_id, undefined);
      await app.update({text:'/skills clear',message_thread_id:threadId,is_topic_message:true});
      assert.equal(app.messages.at(-1)?.text, 'Pending skills cleared.');
      assert.equal(app.messages.at(-1)?.message_thread_id, undefined);
      await app.update({message_thread_id:42,is_topic_message:true,forum_topic_created:{name:'Routing isolation'}});
      await app.update({text:'/skills',message_thread_id:42,is_topic_message:true});
      assert.equal(app.messages.at(-1)?.message_thread_id,42);
      assert.match(String(app.messages.at(-1)?.text), /^No skills selected\./);
    } finally {
      await app.close();
    }
  });
}
