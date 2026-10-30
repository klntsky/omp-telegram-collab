import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerId } from './telegram-data.js';
import { writeConfig } from '../src/config.js';

for (const thread of [undefined,42]) {
  test(`native human roster is plain text in ${thread ? 'a topic' : 'General'}`, async () => {
    const app = await createSmokeApp();
    try {
      app.setCurrentMember({status:'creator'});
      app.setUserRole({id:77,is_bot:false,first_name:'<literal>& name'},'administrator');
      app.setUserRole({id:78,is_bot:true,first_name:'Robot'},'administrator');
      await app.update({text:'/setup'});
      await app.update({text:'/list_admins',message_thread_id:thread});
      const response = app.messages.at(-1)!;
      assert.match(String(response.text), /Owner: Ada/);
      assert.match(String(response.text), /<literal>& name/);
      assert.doesNotMatch(String(response.text), /Robot|FixtureOmpBot/);
      assert.equal(response.parse_mode,undefined);
      const menu = await app.bot.api.getMyCommands({scope:{type:'chat',chat_id:response.chat_id as number}});
      assert.ok(menu.some(command => command.command === 'list_admins'));
    } finally { await app.close(); }
  });
}

for (const change of ['membership','assignment'] as const) {
  test(`roster delivery rechecks ${change} after lookup`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      t.mock.method(app.bot.api,'getChatAdministrators',async () => {
        if (change === 'membership') app.setMember(false);
        else {
          Object.values(app.config.instances)[0]!.chats = [];
          writeConfig(app.config);
        }
        return [{status:'creator' as const,is_anonymous:false,user:{id:ownerId,is_bot:false,first_name:'Hidden roster'}}];
      });
      const before = app.messages.length;
      await app.update({text:'/list_admins'});
      assert.ok(app.messages.slice(before).every(message => !String(message.text).includes('Hidden roster')));
      assert.equal(app.store.listSessions(botId).length,0);
    } finally { await app.close(); }
  });
}

test('administrator roster rejects arguments', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/list_admins @someone'});
    assert.match(String(app.messages.at(-1)!.text),/Usage: \/list_admins/);
  } finally { await app.close(); }
});
