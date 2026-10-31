import { eventually, setForumSetting } from './bot-test-helpers.js';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import type { TopicSession } from '../shared/contracts.js';

for (const command of ['/model_preset Fast','/model_preset']) {
  test(`${command} requires current native administration before starting a host`, async t => {
    const app = await createSmokeApp();
    const presets = t.mock.method(app.runtime,'modelPresets');
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Preset authorization'}});
      const session = app.store.listSessions(botId)[0]!;
      app.setCurrentMember({username:'another_admin',status:'member'});
      await app.update({text:command,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),false);
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      app.setMember(false);
      await app.update({text:command,message_thread_id:42});
      assert.equal(await app.runtime.isRunning(session),false);
      app.setMember(true);
      const ensure = app.runtime.ensure.bind(app.runtime);
      app.runtime.ensure = async target => {
        const binding = await ensure(target);
        app.setCurrentMember({username:'removed_admin',status:'member'});
        return binding;
      };
      await app.update({text:command,message_thread_id:42});
      assert.equal(presets.mock.callCount(),0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });

  test(`${command} rejects unrelated, archived and detached topics`, async t => {
    const app = await createSmokeApp();
    const presets = t.mock.method(app.runtime,'modelPresets');
    try {
      await app.update({text:'/setup'});
      await app.update({text:command,message_thread_id:99});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Archived presets'}});
      await app.update({message_thread_id:42,forum_topic_closed:{}});
      await app.update({text:command,message_thread_id:42});
      await app.update({message_thread_id:42,forum_topic_reopened:{}});
      await app.update({text:'/detach',message_thread_id:42});
      assert.equal(app.store.getTopic({botId,destination:{kind:'topic',chatId,threadId:42}})?.status,'detached');
      await app.update({text:command,message_thread_id:42});
      assert.equal(app.config.instances[Object.keys(app.config.instances)[0]!]!.chats[0]!.default_model_preset,undefined);
      assert.equal(await app.runtime.isRunning(app.store.listSessions(botId)[0]!),false);
      assert.equal(app.connectionCount,0);
      assert.equal(presets.mock.callCount(),0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });
}

test('model preset commands reject malformed arguments and ignore foreign or forwarded commands without starting a host', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset boundaries'}});
    for (const message_thread_id of [42]) {
      for (const text of ['/model_preset Fast extra','/model_preset ../Fast']) {
        await app.update({text,message_thread_id});
      }
    }
    await app.update({text:'/model_preset@AnotherBot Fast',message_thread_id:42});
    await app.update({text:'/model_preset',message_thread_id:42,forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}});
    assert.equal(await app.runtime.isRunning(app.store.listSessions(botId)[0]!),false);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('work-topic preset switches leave the forum default unchanged and General leaves a live host unchanged', async () => {
  const app = await createSmokeApp();
  let activePreset = 'Slow';
  app.runtime.modelPresets = async (_session, name) => {
    if (name) activePreset = name;
    return `Fast\nSlow\nActive preset: ${activePreset}`;
  };
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 3, 1);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Session-only preset'}});
    await app.update({text:'/model_preset Fast',message_thread_id:42});
    const session = app.store.listSessions(botId)[0]!;
    const path = session.instancePath;
    assert.equal(await app.runtime.isRunning(session),true);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    await app.update({text:'/model_preset',message_thread_id:42});
    await setForumSetting(app, 3, 0);
    await setForumSetting(app, 3, 1);
    await app.update({text:'/model_preset',message_thread_id:42});
    assert.equal(activePreset,'Fast');
    assert.equal(app.config.instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.default_model_preset,'Slow');
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('removed preset-list command cannot start or mutate a session and is absent from command menus', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Preset command cutover'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.update({text:'/list_model_presets',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),false);
    assert.deepEqual(app.accepted,[]);
    for (const scope of [{type:'all_group_chats' as const},{type:'chat' as const,chat_id:chatId},{type:'chat_administrators' as const,chat_id:chatId}]) {
      const commands = await app.bot.api.getMyCommands({scope});
      assert.equal(commands.some(command => command.command === 'list_model_presets'),false);
      assert.equal(commands.some(command => command.command === 'model_preset'),true);
    }
  } finally { await app.close(); }
});

for (const root of ['new', 'p']) {
  test(`/${root} invalid preparation has no topic, runtime or prompt effects`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
      const ensure = t.mock.method(app.runtime,'ensure');
      const worktree = t.mock.method(app.runtime,'worktree');
      const presets = t.mock.method(app.runtime,'modelPresets');
      await app.update({text:`/${root} /worktree /model_preset Missing Do the task`});
      assert.equal(app.store.listSessions(botId).length,0);
      assert.equal(ensure.mock.callCount(),0);
      assert.equal(worktree.mock.callCount(),0);
      assert.equal(presets.mock.callCount(),0);
      assert.deepEqual(app.accepted,[]);
      await app.update({text:`/${root} /status Do the task`});
      assert.equal(app.store.listSessions(botId).length,0);
      assert.equal(ensure.mock.callCount(),0);
    } finally { await app.close(); }
  });
}

for (const existing of [false,true]) {
  for (const order of ['worktree-first','preset-first']) {
    test(`composed prompt retains its selected preset across ${existing ? 'existing' : 'new'} session preparation in ${order} order`, async t => {
      const app = await createSmokeApp({skipStartupRejection:true});
      try {
        await app.update({text:'/setup'});
        if (existing) await app.update({message_thread_id:42,forum_topic_created:{name:'Prepared session'}});
        t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
        const effects: string[] = [];
        let activePreset = 'Slow';
        t.mock.method(app.runtime,'worktree',async () => {
          assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,0);
          effects.push('worktree');
          activePreset = 'Slow';
          return 'Prepared worktree';
        });
        t.mock.method(app.runtime,'modelPresets',async (_session: TopicSession, name?: string) => {
          assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,0);
          effects.push(`preset:${name}`);
          activePreset = name!;
          return 'Preset selected';
        });
        const prefix = order === 'worktree-first' ? '/worktree /model_preset Fast' : '/model_preset Fast /worktree';
        await app.update({text:`/${existing ? 'p' : 'new'} ${prefix} Final task`,...(existing ? {message_thread_id:42} : {})});
        await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
        assert.deepEqual(effects,order === 'worktree-first' ? ['worktree','preset:Fast'] : ['preset:Fast','worktree','preset:Fast']);
        assert.equal(activePreset,'Fast');
        assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Final task'}]);
        assert.equal(app.store.listSessions(botId).length,1);
      } finally { await app.close(); }
    });
  }
}

test('mutating prompt extensions cannot become non-admin approval proposals', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app,1);
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    const worktree = t.mock.method(app.runtime,'worktree');
    const presets = t.mock.method(app.runtime,'modelPresets');
    app.setCurrentMember({username:'participant',status:'member'});
    for (const extension of ['/worktree','/model_preset Fast']) {
      await app.update({text:`/new ${extension} Restricted task`},{id:77,is_bot:false,first_name:'Participant',username:'participant'});
    }
    assert.equal(app.store.listSessions(botId).length,0);
    assert.equal(worktree.mock.callCount(),0);
    assert.equal(presets.mock.callCount(),0);
    assert.equal(app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('prompt:approve:')),false);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('failed ordered preparation does not replay the operation or submit its prompt', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    const effects: string[] = [];
    t.mock.method(app.runtime,'worktree',async () => { effects.push('worktree'); return 'Prepared'; });
    t.mock.method(app.runtime,'modelPresets',async () => {
      effects.push('preset');
      throw new Error('Native preset selection failed');
    });
    await app.update({text:'/new /worktree /model_preset Fast Never submit'});
    assert.deepEqual(effects,['worktree','preset']);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.equal(app.store.hasPendingInitialTask(app.store.listSessions(botId)[0]!.id),false);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

test('worktree preparation failure preserves pending skills and never starts a prompt', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({text:'/skill_pdf_tools'});
    const key = {botId,destination:{kind:'general' as const,chatId},userId:ownerId};
    const pending = app.store.getPendingSkills(key);
    assert.deepEqual(pending,['pdf-tools']);
    const presets = t.mock.method(app.runtime,'modelPresets');
    t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
    const worktree = t.mock.method(app.runtime,'worktree',async () => { throw new Error('Native worktree preparation failed'); });
    await app.update({text:'/new /worktree /model_preset Fast Never submit'});
    assert.equal(worktree.mock.callCount(),1);
    assert.equal(presets.mock.callCount(),0);
    assert.equal(app.store.listSessions(botId).length,1);
    assert.equal(app.store.hasPendingInitialTask(app.store.listSessions(botId)[0]!.id),false);
    assert.deepEqual(app.accepted,[]);
    assert.deepEqual(app.store.getPendingSkills(key),pending);
  } finally { await app.close(); }
});

test('administrator revocation during preset discovery prevents every preparation and topic mutation', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    t.mock.method(app.runtime,'availableModelPresets',async () => {
      app.setCurrentMember({username:'participant',status:'member'});
      return ['Fast'];
    });
    const ensure = t.mock.method(app.runtime,'ensure');
    const worktree = t.mock.method(app.runtime,'worktree');
    const presets = t.mock.method(app.runtime,'modelPresets');
    await app.update({text:'/new /model_preset Fast /worktree Never submit'});
    assert.equal(app.store.listSessions(botId).length,0);
    assert.equal(ensure.mock.callCount(),0);
    assert.equal(worktree.mock.callCount(),0);
    assert.equal(presets.mock.callCount(),0);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});

for (const boundary of ['ensure','worktree'] as const) {
  test(`session generation changes across ${boundary} abort the remaining preparation and prompt`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await app.update({message_thread_id:42,forum_topic_created:{name:'Generation boundary'}});
      t.mock.method(app.runtime,'availableModelPresets',async () => ['Fast']);
      const presets = t.mock.method(app.runtime,'modelPresets');
      if (boundary === 'ensure') {
        const ensure = app.runtime.ensure.bind(app.runtime);
        t.mock.method(app.runtime,'ensure',async (session: TopicSession) => {
          const binding = await ensure(session);
          app.store.advanceSessionGeneration(session.id);
          return binding;
        });
      } else {
        t.mock.method(app.runtime,'worktree',async (session: TopicSession) => {
          app.store.advanceSessionGeneration(session.id);
          return 'Prepared';
        });
      }
      await app.update({text:`/p ${boundary === 'worktree' ? '/worktree ' : ''}/model_preset Fast Never submit`,message_thread_id:42});
      assert.equal(presets.mock.callCount(),0);
      assert.deepEqual(app.accepted,[]);
      assert.equal(app.store.listSessions(botId).length,1);
    } finally { await app.close(); }
  });
}

test('failed preset restoration after worktree replacement never admits the task', async t => {
  const app = await createSmokeApp({skipStartupRejection:true});
  try {
    await app.update({text:'/setup'});
    const effects: string[] = [];
    t.mock.method(app.runtime,'worktree',async () => {
      effects.push('worktree');
      return 'Prepared';
    });
    t.mock.method(app.runtime,'modelPresets',async () => {
      effects.push('preset');
      if (effects.includes('worktree')) throw new Error('Preset restoration rejected by replacement host');
      return 'Selected';
    });
    await app.update({text:'/new /model_preset Fast /worktree Never submit'});
    assert.deepEqual(effects,['preset','worktree','preset']);
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.hasPendingInitialTask(session.id),false);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});
