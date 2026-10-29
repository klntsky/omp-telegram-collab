import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { chatId } from './telegram-data.js';
import { Telegraf } from 'telegraf';
import { createBot } from '../src/bot.js';
import { botToken, botId, ownerId, ownerUsername } from './telegram-data.js';

test('restart serves cached shortcuts and reaches polling while discovery is blocked', async t => {
  const app = await createSmokeApp();
  await app.service.close();
  const instancePath = Object.keys(app.config.instances)[0]!;
  app.store.enrollGroup(botId, chatId);
  app.store.setSkillCatalog(instancePath, [{name:'cached-skill',description:'Last successful discovery'}]);
  const discovery = Promise.withResolvers<Array<{name:string;description:string}>>();
  t.mock.method(app.runtime,'listSkills',() => discovery.promise);
  const bot = new Telegraf(botToken, {telegram:{apiRoot:app.telegramUrl}});
  const service = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,bot,telegramIntervalMs:0});
  let polling: Promise<void> | undefined;
  try {
    const ready = Promise.withResolvers<void>();
    polling = service.start(ready.resolve);
    await Promise.race([ready.promise, polling]);
    const commands = await bot.telegram.getMyCommands({scope:{type:'chat',chat_id:chatId}});
    assert.ok(commands.some(command=>command.command==='skill_cached_skill'));
    await bot.handleUpdate({update_id:9000,message:{
      message_id:9000,date:0,chat:{id:chatId,type:'supergroup',title:'Fixture'},
      from:{id:ownerId,first_name:'Ada',username:ownerUsername,is_bot:false},
      text:'/help',
    }});
    assert.match(String(app.messages.at(-1)?.text), /\/skills/);
    const published = Promise.withResolvers<void>();
    const original = bot.telegram.setMyCommands.bind(bot.telegram);
    t.mock.method(bot.telegram,'setMyCommands',async (...args:Parameters<typeof original>) => {
      const result = await original(...args);
      if (args[0].some(command=>command.command==='skill_fresh_skill')) published.resolve();
      return result;
    });
    discovery.resolve([{name:'fresh-skill',description:'Refreshed discovery'}]);
    await published.promise;
    const refreshed = await bot.telegram.getMyCommands({scope:{type:'chat',chat_id:chatId}});
    assert.ok(refreshed.some(command=>command.command==='skill_fresh_skill'));
    assert.ok(!refreshed.some(command=>command.command==='skill_cached_skill'));
    assert.deepEqual(app.store.getSkillCatalog(instancePath),[{name:'fresh-skill',description:'Refreshed discovery'}]);
  } finally {
    discovery.resolve([]);
    await service.close();
    await polling;
    await app.close();
  }
});

test('catalog refresh publishes changes once, removes obsolete aliases and preserves menus on failure', async t => {
  const app = await createSmokeApp();
  try {
    const scope = {type:'chat' as const,chat_id:chatId};
    const original = app.bot.telegram.setMyCommands.bind(app.bot.telegram);
    let writes = 0;
    t.mock.method(app.bot.telegram,'setMyCommands',async (...args:Parameters<typeof original>) => {
      writes++;
      return original(...args);
    });
    await app.service.reconcileConfiguration();
    assert.equal(writes,0);
    const catalog = t.mock.method(app.runtime,'listSkills',async () => [{name:'New-Skill',description:'Newly installed'}]);
    await app.service.reconcileConfiguration();
    const changed = await app.bot.telegram.getMyCommands({scope});
    assert.ok(changed.some(command=>command.command==='skill_new_skill'));
    assert.ok(!changed.some(command=>command.command==='skill_pdf_tools'));
    assert.equal(writes,1);
    await app.service.reconcileConfiguration();
    assert.equal(writes,1);
    const diagnostic = new Error('Catalog discovery failed\nOriginal permission diagnostic');
    catalog.mock.mockImplementation(async () => { throw diagnostic; });
    const originalLog = console.error.bind(console);
    const observed: unknown[] = [];
    t.mock.method(console,'error',(...args:unknown[]) => { observed.push(...args); originalLog(...args); });
    await app.service.reconcileConfiguration();
    assert.deepEqual(await app.bot.telegram.getMyCommands({scope}),changed);
    assert.equal(writes,1);
    assert.ok(observed.includes(diagnostic));
  } finally { await app.close(); }
});

test('menu capacity and alias collisions do not hide canonical skills from inline search', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const skills = [
      {name:'first-name',description:'First collision winner'},
      {name:'first_name',description:'Second collision remains searchable'},
      ...Array.from({length:110},(_,index)=>({name:`entry-${index}`,description:'Available skill'})),
      {name:'技能',description:'Unicode skill without a Telegram alias'},
    ];
    t.mock.method(app.runtime,'listSkills',async () => skills);
    await app.service.reconcileConfiguration();
    const commands = await app.bot.telegram.getMyCommands({scope:{type:'chat',chat_id:chatId}});
    assert.equal(commands.length,100);
    assert.equal(commands.filter(command=>command.command==='skill_first_name').length,1);
    assert.ok(commands.some(command=>command.command==='skills'));
    await app.update({text:'/skills'});
    const markup = app.messages.at(-1)!.reply_markup as {inline_keyboard:Array<Array<{switch_inline_query_current_chat?:string}>>};
    const query = markup.inline_keyboard.flat().find(button=>button.switch_inline_query_current_chat)!.switch_inline_query_current_chat!;
    for (const name of ['first_name','entry-109','技能']) {
      await app.inlineQuery(query+name);
      const results = app.inlineAnswers.at(-1)!.results as Array<{title:string}>;
      assert.ok(results.some(result=>result.title===`/skill:${name}`));
    }
  } finally { await app.close(); }
});
