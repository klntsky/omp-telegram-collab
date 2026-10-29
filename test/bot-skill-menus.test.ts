import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { chatId } from './telegram-data.js';
import { Bot } from 'grammy';
import { createBot } from '../src/bot.js';
import { botToken, botId, ownerId, ownerUsername } from './telegram-data.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('a slow instance does not delay another menu, and close cancels refresh without late publication', {timeout:10000}, async t => {
  const app = await createSmokeApp();
  await app.service.close();
  const firstPath = Object.keys(app.config.instances)[0]!;
  const secondPath = join(firstPath,'second');
  await mkdir(secondPath);
  const secondChat = chatId - 1;
  app.config.instances[secondPath] = {admins:[],chats:[{botId,chatId:secondChat}]};
  const slow = Promise.withResolvers<Array<{name:string;description:string}>>();
  t.mock.method(app.runtime,'listSkills',async (path: string) => path === firstPath ? slow.promise : [{name:'fast-skill',description:'Independent catalog'}]);
  const bot = new Bot(botToken,{client:{apiRoot:app.telegramUrl}});
  const service = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,bot,telegramIntervalMs:0});
  const published = Promise.withResolvers<void>();
  bot.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (method === 'setMyCommands' && JSON.stringify(payload).includes('skill_fast_skill')) published.resolve();
    return result;
  });
  try {
    await service.initialize();
    service.startBackground();
    await published.promise;
    const before = app.store.getSkillCatalog(firstPath);
    await service.close();
    slow.resolve([{name:'late-skill',description:'Must not publish'}]);
    await service.refreshSkillCatalogs();
    assert.deepEqual(app.store.getSkillCatalog(firstPath),before);
    const commands = await bot.api.getMyCommands({scope:{type:'chat',chat_id:secondChat}});
    assert.ok(commands.some(command=>command.command==='skill_fast_skill'));
  } finally { slow.resolve([]); await service.close(); await app.close(); }
});

test('assignment cleanup and acknowledgement do not wait for catalog discovery', {timeout:10000}, async t => {
  const app = await createSmokeApp();
  const pending = Promise.withResolvers<Array<{name:string;description:string}>>();
  const entered = Promise.withResolvers<void>();
  t.mock.method(app.runtime,'listSkills',() => { entered.resolve(); return pending.promise; });
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Removed assignment'}});
    const instancePath = Object.keys(app.config.instances)[0]!;
    const session = app.store.listSessions(botId)[0]!;
    const detached: string[] = [];
    app.service.onSessionKill(id => detached.push(id));
    const before = app.store.getSkillCatalog(instancePath);
    const refresh = app.service.refreshSkillCatalogs();
    await entered.promise;
    app.config.instances[instancePath]!.chats = [];
    await app.service.reconcileConfiguration();
    assert.deepEqual(detached,[session.id]);
    assert.deepEqual(await app.bot.api.getMyCommands({scope:{type:'chat',chat_id:chatId}}),[]);
    pending.resolve([{name:'stale-skill',description:'Old assignment'}]);
    await refresh;
    assert.deepEqual(app.store.getSkillCatalog(instancePath),before);
  } finally { pending.resolve([]); await app.close(); }
});

test('restart serves cached shortcuts and reaches polling while discovery is blocked', async t => {
  const app = await createSmokeApp();
  await app.service.close();
  const instancePath = Object.keys(app.config.instances)[0]!;
  app.store.enrollGroup(botId, chatId);
  app.store.setSkillCatalog(instancePath, [{name:'cached-skill',description:'Last successful discovery'}]);
  const discovery = Promise.withResolvers<Array<{name:string;description:string}>>();
  t.mock.method(app.runtime,'listSkills',() => discovery.promise);
  const bot = new Bot(botToken, {client:{apiRoot:app.telegramUrl}});
  const service = createBot({config:app.config,botConfig:app.config.bots[0]!,token:botToken,store:app.store,runtime:app.runtime,bot,telegramIntervalMs:0});
  let polling: Promise<void> | undefined;
  try {
    const ready = Promise.withResolvers<void>();
    polling = service.start(ready.resolve);
    await Promise.race([ready.promise, polling]);
    service.startBackground();
    const commands = await bot.api.getMyCommands({scope:{type:'chat',chat_id:chatId}});
    assert.ok(commands.some(command=>command.command==='skill_cached_skill'));
    await bot.handleUpdate({update_id:9000,message:{
      message_id:9000,date:0,chat:{id:chatId,type:'supergroup',title:'Fixture'},
      from:{id:ownerId,first_name:'Ada',username:ownerUsername,is_bot:false},
      text:'/help',
    }});
    assert.match(String(app.messages.at(-1)?.text), /\/skills/);
    discovery.resolve([{name:'fresh-skill',description:'Refreshed discovery'}]);
    await service.refreshSkillCatalogs();
    const refreshed = await bot.api.getMyCommands({scope:{type:'chat',chat_id:chatId}});
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

test('catalog refresh removes obsolete aliases and preserves menus on failure', async t => {
  const app = await createSmokeApp();
  try {
    const scope = {type:'chat' as const,chat_id:chatId};
    const catalog = t.mock.method(app.runtime,'listSkills',async () => [{name:'New-Skill',description:'Newly installed'}]);
    await app.service.refreshSkillCatalogs();
    const changed = await app.bot.api.getMyCommands({scope});
    assert.ok(changed.some(command=>command.command==='skill_new_skill'));
    assert.ok(!changed.some(command=>command.command==='skill_pdf_tools'));
    const diagnostic = new Error('Catalog discovery failed\nOriginal permission diagnostic');
    catalog.mock.mockImplementation(async () => { throw diagnostic; });
    const originalLog = console.error.bind(console);
    const observed: unknown[] = [];
    t.mock.method(console,'error',(...args:unknown[]) => { observed.push(...args); originalLog(...args); });
    await app.service.refreshSkillCatalogs();
    assert.deepEqual(await app.bot.api.getMyCommands({scope}),changed);
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
    await app.service.refreshSkillCatalogs();
    const commands = await app.bot.api.getMyCommands({scope:{type:'chat',chat_id:chatId}});
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
