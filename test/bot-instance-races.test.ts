import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { z } from 'zod';
import { writeConfig } from '../src/config.js';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { setForumSetting } from './bot-test-helpers.js';

const photo = [{file_id:'race-photo',file_unique_id:'race-photo',width:100,height:100}];
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string().optional()})))});

test('General skill picker rejects the same logical instance after its default directory changes', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/skills'});
    const panel = app.messages.at(-1)!;
    const button = markup.parse(panel.reply_markup).inline_keyboard.flat().find(value => value.callback_data?.startsWith('skills:add:'))!;
    assert.ok(button?.callback_data);
    const instance = app.config.instances[0]!;
    const id = instance.id;
    instance.defaultDir = realpathSync(tmpdir());
    writeConfig(app.config);
    await app.callback(button.callback_data,panel);
    assert.equal(app.config.instances[0]!.id,id);
    assert.deepEqual(app.store.getPendingSkills({botId,destination:{kind:'general',chatId},userId:ownerId}),[]);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
  } finally { await app.close(); }
});

for (const caption of ['/new Download race','General download race']) {
  test(`defaultDir change during image retrieval rejects ${caption.startsWith('/new') ? '/new' : 'General'} admission`, async t => {
    const app = await createSmokeApp();
    app.mockFiles(t,imageData);
    try {
      await app.update({text:'/setup'});
      let changed = false;
      app.bot.api.config.use(async (previous,method,payload,signal) => {
        const result = await previous(method,payload,signal);
        if (method === 'getFile') {
          app.config.instances[0]!.defaultDir = realpathSync(tmpdir());
          writeConfig(app.config);
          changed = true;
        }
        return result;
      });
      await app.update({photo,caption});
      assert.equal(changed,true);
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.deepEqual(app.createdTopics,[]);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}

test('defaultDir change while createForumTopic is awaited prevents storing or submitting the stale session', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    let changed = false;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      const result = await previous(method,payload,signal);
      if (method === 'createForumTopic') {
        app.config.instances[0]!.defaultDir = realpathSync(tmpdir());
        writeConfig(app.config);
        changed = true;
      }
      return result;
    });
    await app.update({text:'/new Topic creation race'});
    assert.equal(changed,true);
    assert.equal(app.createdTopics.length,1);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    assert.equal(app.connectionCount,0);
  } finally { await app.close(); }
});

for (const boundary of ['proposer authorization','final administrator check']) {
  test(`proposal defaultDir change during ${boundary} prevents new-session creation`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await setForumSetting(app,1);
      const proposer = {id:ownerId+5,is_bot:false,first_name:'Grace',username:'grace'};
      app.setUserRole(proposer,'member');
      await app.update({text:'/new Proposal race'},proposer);
      const panel = app.messages.at(-1)!;
      const approve = markup.parse(panel.reply_markup).inline_keyboard.flat().find(value => value.callback_data?.startsWith('prompt:approve:'))!;
      assert.ok(approve?.callback_data);
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      let finalCheck = false;
      let changed = false;
      app.bot.api.config.use(async (previous,method,payload,signal) => {
        const result = await previous(method,payload,signal);
        if (method === 'editMessageReplyMarkup') finalCheck = true;
        if (!changed && method === 'getChatMember' &&
            (boundary === 'proposer authorization' ? 'user_id' in payload && Number(payload.user_id) === proposer.id : finalCheck)) {
          app.config.instances[0]!.defaultDir = realpathSync(tmpdir());
          writeConfig(app.config);
          changed = true;
        }
        return result;
      });
      await app.callback(approve.callback_data,panel);
      assert.equal(changed,true);
      assert.deepEqual(app.createdTopics,[]);
      assert.deepEqual(app.store.listSessions(botId),[]);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
      assert.equal(app.connectionCount,0);
    } finally { await app.close(); }
  });
}
