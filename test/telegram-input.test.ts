import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'grammy';
import { classifyMessage, normalizeMessage, type InputContext } from '../src/telegram-input.js';

const botId = 100;
const from = {id:1,is_bot:false,first_name:'User'};
function message(fields: Record<string, unknown>) {
  return {message_id:20,date:1,chat:{id:-100,type:'supergroup',title:'Forum'},from,...fields} as NonNullable<Context['message']>;
}
function context(overrides: Partial<InputContext> = {}): InputContext {
  return {botId,username:'FixtureOmpBot',allMessagesArePrompts:true,commands:new Set(['new','p','settings']),skillAliases:new Map(),endedQuestion:false,...overrides};
}
const replies = [
  undefined,
  {message_id:10,from:{id:botId,is_bot:true,first_name:'Bot'},text:'Settings panel'},
  {message_id:11,from:{id:botId,is_bot:true,first_name:'Bot'},text:'Current question'},
  {message_id:12,from:{id:botId,is_bot:true,first_name:'Bot'},text:'Old question'},
  {message_id:13,from:{id:botId,is_bot:true,first_name:'Bot'},caption:'Bot image'},
];

for (const allMessagesArePrompts of [true,false]) {
  for (const thread of [undefined,1,42]) {
    for (const reply of replies) {
      for (const state of [{},{question:'active'},{endedQuestion:true}]) {
        test(`commands precede reply interpretation: mode=${allMessagesArePrompts}, thread=${thread}, reply=${reply?.message_id}, state=${JSON.stringify(state)}`, () => {
          const ctx = context({allMessagesArePrompts,...state});
          for (const [text,kind] of [['/new Task','new-task'],['/new','new-task'],['/p','session-prompt'],['/p@fixtureompbot Task','session-prompt'],['/settings','command'],['/unknown Task','ignore'],['/p@OtherBot Task','ignore'],['/p! Task','ignore'],['/','ignore']] as const) {
            const msg = message({text,message_thread_id:thread,reply_to_message:reply});
            const intent = classifyMessage(msg,normalizeMessage([msg]),ctx);
            assert.equal(intent.kind,kind);
            if (intent.kind === 'command') assert.deepEqual(intent,{kind:'command',action:'settings',argument:''});
            if (intent.kind === 'new-task' || intent.kind === 'session-prompt') {
              const quoted = reply && ('text' in reply ? reply.text : reply.caption);
              const argument = text.endsWith(' Task') ? 'Task' : '';
              assert.deepEqual(intent.content,{text:quoted ? argument ? `> ${quoted}\n\n${argument}` : `> ${quoted}` : argument,images:[]});
            }
          }
        });
      }
    }
    test(`ordinary classification is destination independent: mode=${allMessagesArePrompts}, thread=${thread}`, () => {
      const ctx = context({allMessagesArePrompts});
      const msg = message({text:'Task',message_thread_id:thread});
      assert.deepEqual(classifyMessage(msg,normalizeMessage([msg]),ctx),allMessagesArePrompts ? {kind:'session-prompt',content:{text:'Task',images:[]}} : {kind:'ignore'});
      const directed = message({text:'Task',message_thread_id:thread,reply_to_message:replies[4]});
      assert.deepEqual(classifyMessage(directed,normalizeMessage([directed]),ctx),{kind:'session-prompt',content:{text:'> Bot image\n\nTask',images:[]}});
    });
  }
}

test('only non-command content enters question precedence before prompts', () => {
  const msg = message({text:'Answer',reply_to_message:replies[2]});
  const content = normalizeMessage([msg]);
  assert.deepEqual(classifyMessage(msg,content,context({question:'token',endedQuestion:true})),{kind:'question-answer',token:'token',text:'Answer'});
  assert.deepEqual(classifyMessage(msg,content,context({endedQuestion:true})),{kind:'ended-question'});
});

test('image-only content is meaningful while empty messages never answer questions', () => {
  const image = message({photo:[{file_id:'small',file_unique_id:'small',width:10,height:10},{file_id:'large',file_unique_id:'large',width:100,height:100}]});
  const content = {text:'',images:[{fileId:'large',mimeType:'image/jpeg'}]};
  assert.deepEqual(normalizeMessage([image]),content);
  assert.deepEqual(classifyMessage(image,content,context()),{kind:'session-prompt',content});
  assert.deepEqual(classifyMessage(image,content,context({allMessagesArePrompts:false})),{kind:'ignore'});
  assert.deepEqual(classifyMessage(image,content,context({question:'token'})),{kind:'question-answer',token:'token',text:''});
  for (const text of ['', ' \n\t ']) {
    const msg = message({text});
    assert.deepEqual(classifyMessage(msg,normalizeMessage([msg]),context({question:'token',endedQuestion:true})),{kind:'ignore'});
  }
});
