import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig } from '../src/config.js';
import { test } from 'node:test';
import { z } from 'zod';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { eventually, setForumSetting } from './bot-test-helpers.js';

test('default mode starts a session host from ordinary text without a mention', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'All messages'}});
    assert.equal(app.connectionCount,0);
    const rejection = once(app.events,'message');
    await app.update({text:'Implement ordinary text\nwith multiple lines',message_thread_id:42});
    await rejection;
    await app.update({text:'Implement ordinary text\nwith multiple lines',message_thread_id:42});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement ordinary text\nwith multiple lines'},
    ]);
    await app.update({text:'/unrecognized command',message_thread_id:42});
    assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,1);
    await app.update({text:'Create from ordinary General text'});
    await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1),
      {t:'prompt',text:'Create from ordinary General text'});
    const generalSession = app.store.listSessions(botId).find(session => session.threadId !== 42)!;
    assert.ok(generalSession);
    assert.notEqual(generalSession.threadId,1);
    assert.equal(app.store.getTopic({botId,destination:{kind:'general',chatId}}),undefined);
  } finally { await app.close(); }
});

test('explicit mode ignores discussion and mentions, and admits scoped /p prompts', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 0, 1);
    const path = Object.keys(app.config.instances)[0]!;
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,false);
    await app.update({message_thread_id:42,forum_topic_created:{name:'Explicit prompts'}});
    const reactions = app.reactions.length;
    await app.update({text:'Ordinary discussion',message_thread_id:42});
    await app.update({text:'@FixtureOmpBot Still discussion',message_thread_id:42,entities:[{type:'mention',offset:0,length:14}]});
    await app.update({text:'A reply to someone else',message_thread_id:42,reply_to_message:{message_id:9000,from:{id:botId+1,is_bot:true,first_name:'Other'}}});
    await app.update({
      text:'Ordinary discussion with implicit topic-root metadata',message_thread_id:42,is_topic_message:true,
      reply_to_message:{
        message_id:42,from:{id:botId,is_bot:true,first_name:'OMP'},
        forum_topic_created:{name:'Explicit prompts',icon_color:0},
      },
    });
    await app.update({
      text:'Ordinary discussion with a partial topic-root message',message_thread_id:42,is_topic_message:true,
      reply_to_message:{message_id:42,from:{id:botId,is_bot:true,first_name:'OMP'}},
    });
    assert.equal(app.connectionCount,0);
    assert.equal(app.reactions.length,reactions);
    await app.update({text:'/p',message_thread_id:42});
    await app.update({text:'/p@AnotherBot Not for this bot',message_thread_id:42});
    await app.update({text:'/p Forwarded instruction',message_thread_id:42,forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}});
    assert.equal(app.connectionCount,0);
    const rejection = once(app.events,'message');
    await app.update({message_id:7100,text:'/p@FixtureOmpBot Implement explicit text\nwith multiple lines',message_thread_id:42});
    await rejection;
    await app.update({message_id:7100,text:'/p@FixtureOmpBot Implement explicit text\nwith multiple lines',message_thread_id:42});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement explicit text\nwith multiple lines'},
    ]);
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(app.store.getReplyTarget(session.id),7100);
    await app.update({message_thread_id:42,forum_topic_closed:{}});
    await app.update({text:'/p Archived instruction',message_thread_id:42});
    assert.equal(await app.runtime.isRunning(session),false);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Implement explicit text\nwith multiple lines'},
    ]);
    await app.update({text:'/setup'});
    await setForumSetting(app, 0, 0);
    assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.all_messages_are_prompts,true);
  } finally { await app.close(); }
});


for (const allMessagesArePrompts of [true,false]) {
  test(`bot-directed replies quote context and create sessions from General with all messages: ${allMessagesArePrompts}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (!allMessagesArePrompts) await setForumSetting(app, 0, 1);
      const from = {id:botId,is_bot:true,first_name:'OMP'};
      await app.update({message_id:7200,text:'Explain this',reply_to_message:{message_id:9100,from,caption:'Original\ncontext'}});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'> Original\n> context\n\nExplain this'},
      ]);
      await app.update({message_id:7201,text:'Continue',message_thread_id:session.threadId,
        reply_to_message:{message_id:9101,from,text:'Next answer'}});
      await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt')[1],
        {t:'prompt',text:'> Next answer\n\nContinue'});
      assert.equal(app.store.getReplyTarget(session.id),7201);
    } finally { await app.close(); }
  });
}

for (const allMessagesArePrompts of [true, false]) {
  for (const command of ['/p', '/new']) {
  test(`${command} includes replied-to text and captions as greentext with all messages: ${allMessagesArePrompts}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (!allMessagesArePrompts) await setForumSetting(app, 0, 1);
      await app.update({text:command,reply_to_message:{message_id:9000,caption:'Screenshot context\nsecond line',
        photo:[{file_id:'quoted-photo',file_unique_id:'quoted-photo',width:100,height:100}]}});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'> Screenshot context\n> second line'},
      ]);
      const session = app.store.listSessions(botId)[0]!;
      await app.update({text:`${command}@FixtureOmpBot Explain this`,message_thread_id:session.threadId,
        reply_to_message:{message_id:9001,text:'Original text\n\n  indented line',
          document:{file_id:'quoted-document',file_unique_id:'quoted-document',mime_type:'image/png'}}});
      await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'> Screenshot context\n> second line'},
        {t:'prompt',text:'> Original text\n> \n>   indented line\n\nExplain this'},
      ]);
    } finally { await app.close(); }
  });
  }
}

for (const allMessagesArePrompts of [true, false]) {
    test(`/p in General creates a session like /new (all messages: ${allMessagesArePrompts})`, async () => {
      const app = await createSmokeApp();
      try {
        await app.update({text:'/setup'});
        if (!allMessagesArePrompts) await setForumSetting(app, 0, 1);
        await app.update({text:'/p@FixtureOmpBot Create from General',message_thread_id:1});
        await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
        const session = app.store.listSessions(botId)[0]!;
        assert.notEqual(session.threadId,1);
        assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Create from General'}]);
        assert.equal(app.store.getTopic({botId,destination:{kind:'general',chatId}}),undefined);
      } finally { await app.close(); }
    });
}

test('empty new-session commands do not create sessions or request replies', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 0, 1);
    const before = app.messages.slice();
    for (const text of ['/new','/new@FixtureOmpBot','/p','/p@FixtureOmpBot']) await app.update({text});
    assert.deepEqual(app.messages,before);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[]);
    await app.update({text:'/new Create this explicit-mode session'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Create this explicit-mode session'},
    ]);
  } finally { await app.close(); }
});

function promptProposal(app: {messages:Record<string, unknown>[]}) {
  const message = app.messages.findLast(message => JSON.stringify(message.reply_markup)?.includes('prompt:approve:'));
  assert.ok(message,'a proposal must present an approval button');
  const markup = z.object({inline_keyboard:z.array(z.array(z.object({callback_data:z.string()})))}).parse(message.reply_markup);
  return {message,approve:markup.inline_keyboard[0]![0]!.callback_data};
}

for (const allMessagesArePrompts of [true,false]) {
  test(`non-admin prompts are ignored by default with all_messages_are_prompts=${allMessagesArePrompts}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      if (!allMessagesArePrompts) await setForumSetting(app, 0, 1);
      await app.update({message_thread_id:42,forum_topic_created:{name:'Admin prompts only'}});
      app.setCurrentMember({username:'another_user',status:'member'});
      const before = app.messages.length;
      const reactions = app.reactions.length;
      await app.update({text:allMessagesArePrompts ? 'Ignored task' : '/p Ignored task',message_thread_id:42});
      await app.update({text:'/new Ignored new session'});
      await app.update({text:'/new'});
      assert.equal(app.messages.length,before);
      assert.equal(app.reactions.length,reactions);
      assert.equal(app.connectionCount,0);
      assert.deepEqual(app.accepted,[]);
    } finally { await app.close(); }
  });

  test(`non-admin prompts wait for one group administrator approval with all_messages_are_prompts=${allMessagesArePrompts}`, async () => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await setForumSetting(app, 1, 0);
      if (!allMessagesArePrompts) await setForumSetting(app, 0, 1);
      await app.update({text:'/new Seed task'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      const path = Object.keys(app.config.instances)[0]!;
      assert.equal(readConfig(app.config.configPath).instances[path]!.chats[0]!.users_can_propose_prompts,true);
      const proposer = {id:ownerId+5,first_name:'Grace',username:'grace',is_bot:false};
      app.setCurrentMember({username:'grace',status:'member'});
      await app.update({message_id:8100,text:allMessagesArePrompts ? 'Proposed multiline\n  task' : '/p Proposed multiline\n  task',message_thread_id:session.threadId},proposer);
      const proposal = promptProposal(app);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
      await app.callback(proposal.approve,proposal.message,proposer);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      await app.callback(proposal.approve,{...proposal.message,message_thread_id:session.threadId+1});
      await app.callback(proposal.approve,{...proposal.message,message_id:Number(proposal.message.message_id)+1});
      await app.callback(proposal.approve,{...proposal.message,forward_date:1});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
      await app.callback(proposal.approve,proposal.message);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'Seed task'},{t:'prompt',text:'Proposed multiline\n  task'},
      ]);
      assert.equal(app.store.getReplyTarget(session.id),8100);
      await app.callback(proposal.approve,proposal.message);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'Seed task'},{t:'prompt',text:'Proposed multiline\n  task'},
      ]);
      await app.update({text:allMessagesArePrompts ? 'Direct admin task' : '/p Direct admin task',message_thread_id:session.threadId});
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
        {t:'prompt',text:'Seed task'},{t:'prompt',text:'Proposed multiline\n  task'},{t:'prompt',text:'Direct admin task'},
      ]);
    } finally { await app.close(); }
  });
}

for (const invalidation of ['disabled','archived','killed','removed','expired','requester-left'] as const) {
  test(`a ${invalidation} proposal cannot execute on approval`, async t => {
    const app = await createSmokeApp();
    try {
      await app.update({text:'/setup'});
      await setForumSetting(app, 1, 0);
      await app.update({text:'/new Seed task'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const session = app.store.listSessions(botId)[0]!;
      app.setCurrentMember({username:'grace',status:'member'});
      await app.update({text:'Must not execute',message_thread_id:session.threadId});
      const proposal = promptProposal(app);
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      if (invalidation === 'disabled') app.config.instances[session.instancePath]!.chats[0]!.users_can_propose_prompts = false;
      else if (invalidation === 'archived') await app.update({message_thread_id:session.threadId,forum_topic_closed:{}});
      else if (invalidation === 'killed') await app.update({text:'/kill',message_thread_id:session.threadId});
      else if (invalidation === 'removed') app.config.instances[session.instancePath]!.chats = [];
      else if (invalidation === 'expired') {
        const now = Date.now();
        t.mock.method(Date,'now',() => now+600001);
      } else {
        const getMember = app.bot.api.getChatMember.bind(app.bot.api);
        t.mock.method(app.bot.api,'getChatMember',async (...args: Parameters<typeof getMember>) => {
          const member = await getMember(...args);
          return args[1] === ownerId ? {...member,status:'left' as const} : member;
        });
        await app.callback(proposal.approve,proposal.message,{id:ownerId+10,first_name:'Other admin',username:ownerUsername,is_bot:false});
      }
      if (invalidation !== 'requester-left') await app.callback(proposal.approve,proposal.message);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed task'}]);
    } finally { await app.close(); }
  });
}

test('a non-admin /new task creates no session until a group administrator approves', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    await app.update({text:'/setup'});
    await setForumSetting(app, 1, 0);
    app.setCurrentMember({username:'grace',status:'member'});
    await app.update({text:'/new Proposed initial task'});
    const proposal = promptProposal(app);
    assert.deepEqual(app.store.listSessions(botId),[]);
    assert.equal(app.connectionCount,0);
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    await app.callback(proposal.approve,proposal.message);
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Proposed initial task'}]);
    assert.equal(app.store.listSessions(botId)[0]!.name,'Proposed initial task');
  } finally { await app.close(); }
});

test('approval sends one reply reference and submits the stored proposal text', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    await setForumSetting(app, 1, 0);
    await app.update({text:'/new Seed task'});
    await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
    const session = app.store.listSessions(botId)[0]!;
    const proposer = {id:ownerId+5,first_name:'Grace',username:'grace',is_bot:false};
    const text = '😀'.repeat(2047)+'x';
    app.setCurrentMember({username:'grace',status:'member'});
    const before = app.messages.length;
    await app.update({message_id:8200,text,message_thread_id:session.threadId},proposer);
    assert.equal(app.messages.length,before+1);
    assert.deepEqual(app.messages.at(-1)!.reply_parameters,{message_id:8200,allow_sending_without_reply:true});
    const proposal = promptProposal(app);
    app.setCurrentMember({username:ownerUsername,status:'creator'});
    await app.callback(proposal.approve,proposal.message);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[
      {t:'prompt',text:'Seed task'},{t:'prompt',text},
    ]);
  } finally { await app.close(); }
});

for (const target of ['settings','question'] as const) {
  for (const command of ['/new','/p','/settings','/unknown','/p@AnotherBot','/p!']) {
    test(`${command} replying to ${target} retains command routing`, async () => {
      const app = await createSmokeApp();
      try {
        await app.update({text:'/setup'});
        await app.update({text:'/new Seed'});
        await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
        const session = app.store.listSessions(botId)[0]!;
        if (target === 'settings') await app.update({text:'/settings',message_thread_id:session.threadId});
        else {
          app.emit({t:'ui-request',request:{kind:'editor',reqId:201,title:'Input'}});
          await eventually(() => app.messages.some(message => JSON.stringify(message.reply_markup)?.includes('force_reply')));
        }
        const reply = app.messages.at(-1)!;
        const before = app.accepted.length;
        const sessions = app.store.listSessions(botId).length;
        await app.update({text:`${command} Task`,message_thread_id:session.threadId,reply_to_message:reply});
        assert.equal(app.accepted.slice(before).some(frame => frame.t === 'ui-response'),false);
        if (command === '/new' || command === '/p') {
          await eventually(() => app.accepted.slice(before).some(frame => frame.t === 'prompt'));
          assert.equal(app.store.listSessions(botId).length,sessions + (command === '/new' ? 1 : 0));
        } else {
          assert.equal(app.accepted.slice(before).some(frame => frame.t === 'prompt'),false);
          assert.equal(app.store.listSessions(botId).length,sessions);
          if (command === '/settings') {
            assert.ok(JSON.stringify(app.messages.at(-1)!.reply_markup).includes('settings:'));
          }
        }
        if (target === 'question') {
          await app.update({text:'Answer',message_thread_id:session.threadId,reply_to_message:reply});
          await eventually(() => app.accepted.some(frame => frame.t === 'ui-response' && frame.reqId === 201));
          assert.deepEqual(app.accepted.find(frame => frame.t === 'ui-response' && frame.reqId === 201),
            {t:'ui-response',reqId:201,value:'Answer'});
        }
      } finally { await app.close(); }
    });
  }
}

for (const general of [false,true]) {
  test(`image-only proposals retain bytes through administrator approval in ${general ? 'General' : 'a session'}`, async t => {
    const app = await createSmokeApp();
    const data = Buffer.from('proposal-image').toString('base64');
    app.mockFiles(t,data);
    try {
      await app.update({text:'/setup'});
      await setForumSetting(app,1,0);
      await app.update({text:'/new Seed'});
      await eventually(() => app.accepted.some(frame => frame.t === 'prompt'));
      const seed = app.store.listSessions(botId)[0]!;
      const proposer = {id:ownerId+5,first_name:'Grace',username:'grace',is_bot:false};
      app.setCurrentMember({username:'grace',status:'member'});
      await app.update({message_id:8300,...(general ? {} : {message_thread_id:seed.threadId}),
        photo:[{file_id:'proposal-photo',file_unique_id:'proposal-photo',width:100,height:100}]},proposer);
      const proposal = promptProposal(app);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'),[{t:'prompt',text:'Seed'}]);
      app.setCurrentMember({username:ownerUsername,status:'creator'});
      await app.callback(proposal.approve,proposal.message);
      await eventually(() => app.accepted.filter(frame => frame.t === 'prompt').length === 2);
      assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt').at(-1),
        {t:'prompt',text:'',images:[{type:'image',data,mimeType:'image/jpeg'}]});
      assert.equal(app.store.listSessions(botId).length,general ? 2 : 1);
      await app.callback(proposal.approve,proposal.message);
      assert.equal(app.accepted.filter(frame => frame.t === 'prompt').length,2);
    } finally { await app.close(); }
  });
}
