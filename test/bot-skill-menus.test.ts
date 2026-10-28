import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { chatId } from './telegram-data.js';

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
