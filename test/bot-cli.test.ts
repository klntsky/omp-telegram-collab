import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { writeConfig } from '../src/config.js';
import { botId, chatId } from './telegram-data.js';

function copies(messages: Record<string,unknown>[]): string[] {
  return messages.flatMap(message => {
    const markup = message.reply_markup as {inline_keyboard?:{copy_text?:{text:string}}[][]} | undefined;
    return markup?.inline_keyboard?.flatMap(row => row.flatMap(button => button.copy_text ? [button.copy_text.text] : [])) ?? [];
  });
}

for (const enabled of [true,false]) {
  test(`/cli copies only Telegram coordinates without starting a host with Mini App ${enabled ? 'enabled' : 'disabled'}`, async t => {
    const app = await createSmokeApp();
    try {
      if (!enabled) {
        app.config.publicUrl = '';
        delete app.config.bots[0]!.miniAppShortName;
      }
      await app.service.reconcileConfiguration();
      await app.update({text:'/setup'});
      const instancePath = Object.keys(app.config.instances)[0]!;
      const session = app.store.createSession({botId,chatId,threadId:42,instancePath},'Terminal session');
      const ensure = t.mock.method(app.runtime,'ensure',async () => { throw new Error('Unexpected host startup'); });
      const before = app.messages.length;
      await app.update({text:'/cli',message_thread_id:42});
      const replies = app.messages.slice(before);
      const command = `omp-telegram-collab session join --chat ${chatId} --topic 42`;
      assert.deepEqual(copies(replies),[command]);
      const reply = replies.find(message => copies([message]).length)!;
      assert.ok(!String(reply.text).includes(session.id));
      assert.ok(!String(reply.text).includes(instancePath));
      assert.ok(!String(reply.text).includes(app.config.configPath));
      assert.equal(ensure.mock.callCount(),0);
      assert.equal(app.connectionCount,0);
      for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId}]) {
        assert.ok(!(await app.bot.api.getMyCommands({scope})).some(command => command.command === 'cli'));
      }
      const adminCommands = await app.bot.api.getMyCommands({scope:{type:'chat_administrators',chat_id:chatId}});
      assert.ok(adminCommands.some(command => command.command === 'cli'));
      assert.ok(adminCommands.length <= 100);
    } finally { await app.close(); }
  });
}

for (const denial of ['member','demoted','departed','general','missing','closed','detached','reassigned','terminated'] as const) {
  test(`/cli rejects ${denial} without issuing a join command or starting a host`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      const instancePath = Object.keys(app.config.instances)[0]!;
      const session = app.store.createSession({botId,chatId,threadId:42,instancePath},'Restricted session');
      if (denial === 'demoted') await app.update({text:'/cli',message_thread_id:42});
      if (denial === 'member' || denial === 'demoted') app.setCurrentMember({status:'member'});
      if (denial === 'departed') app.setMember(false);
      if (denial === 'closed' || denial === 'detached') app.store.updateSession(session.id,{status:denial});
      if (denial === 'reassigned') app.config.instances[instancePath]!.chats = [];
      if (denial === 'terminated') { app.config.terminated = true; writeConfig(app.config); }
      const ensure = t.mock.method(app.runtime,'ensure',async () => { throw new Error('Unexpected host startup'); });
      const before = app.messages.length;
      await app.update({text:'/cli',...(denial === 'general' ? {} : {message_thread_id:denial === 'missing' ? 43 : 42})});
      assert.deepEqual(copies(app.messages.slice(before)),[]);
      assert.equal(ensure.mock.callCount(),0);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('removing a group assignment removes its administrator CLI menu', async () => {
  const app = await createSmokeApp();
  try {
    const scope = {type:'chat_administrators' as const,chat_id:chatId};
    assert.ok((await app.bot.api.getMyCommands({scope})).some(command => command.command === 'cli'));
    app.config.instances = {};
    await app.service.reconcileConfiguration();
    assert.deepEqual(await app.bot.api.getMyCommands({scope}),[]);
  } finally { await app.close(); }
});
