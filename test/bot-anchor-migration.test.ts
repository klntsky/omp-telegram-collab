import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { CustomMessageEntry, MessageEntry } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { openVersionOneDatabase } from './schema-v1.js';
import { eventually } from './bot-test-helpers.js';
import { botId, chatId } from './telegram-data.js';

function answer(id: string, parentId: string, text: string): MessageEntry {
  return {type:'message',id,parentId,timestamp:new Date(1000).toISOString(),message:{
    role:'assistant',content:[{type:'text',text}],timestamp:1000,model:'fixture',stopReason:'stop',
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},
  }};
}
function receipt(id: string, parentId: string, content: string): CustomMessageEntry {
  return {type:'custom_message',id,parentId,customType:'collab-prompt',content,
    details:{from:'Telegram @FixtureOmpBot'},display:true,timestamp:new Date(1000).toISOString()};
}

test('anchor migration version-one startup adopts receipts and suppresses only legacy snapshot outputs', async () => {
  const sessionId = 'legacy-session';
  const known = answer('known-output', 'old-receipt', 'Previously delivered');
  const duplicate = answer('same-old-output', known.id, 'Previously delivered');
  const missed = answer('missed-output', 'old-receipt', 'Missed while disconnected');
  const acceptedOutput = answer('accepted-output', 'pending-receipt', 'Accepted before restart');
  const app = await createSmokeApp({persistentStore:true,skipStartupRejection:true,
    initialEntries:[receipt('old-receipt','old-parent','Old prompt'),known,duplicate,missed,
      receipt('pending-receipt',missed.id,'Pending prompt'),acceptedOutput],
    prepareDatabase(filename, instancePath) {
      const db = openVersionOneDatabase(filename);
      try {
        db.prepare('INSERT INTO groups VALUES (?,?)').run(botId,chatId);
        db.prepare('INSERT INTO sessions (id,bot_id,chat_id,thread_id,instance_path,name,status,runtime,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(sessionId,botId,chatId,42,instancePath,'Migrated topic','open',JSON.stringify({kind:'managed'}),1000);
        db.prepare('INSERT INTO snapshot_baselines VALUES (?)').run(sessionId);
        db.prepare('INSERT INTO reply_targets VALUES (?,?)').run(sessionId,8000);
        db.prepare('INSERT INTO prompt_receipts VALUES (?,?,?)').run(sessionId,'old-receipt',8000);
        db.prepare('INSERT INTO prompt_submissions (id,session_id,sender,message_id,text,fingerprint,state) VALUES (?,?,?,?,?,?,?)')
          .run(19,sessionId,'Telegram @FixtureOmpBot',8001,'Pending prompt','unused-text-only-fingerprint','pending');
        db.prepare('INSERT INTO replies VALUES (?,?,?)').run(sessionId,
          createHash('sha256').update(JSON.stringify([1000,'Previously delivered'])).digest('hex'),1000);
      } finally { db.close(); }
    },
  });
  try {
    const session = app.store.getSession(sessionId)!;
    const binding = await app.runtime.ensure(session);
    await app.service.ensureMirroring(session,binding);
    const anchors = () => app.store.db.prepare("SELECT message_id,entry_id FROM message_anchors WHERE session_id=? AND kind='assistant' ORDER BY message_id").all(sessionId);
    await eventually(() => anchors().length === 2);
    assert.deepEqual(anchors().map(row => row.entry_id),[missed.id,acceptedOutput.id]);
    for (const [entryId,target] of [[missed.id,8000],[acceptedOutput.id,8001]] as const) {
      const anchor = anchors().find(row => row.entry_id === entryId)!;
      const message = app.messages.find(message => message.message_id === Number(anchor.message_id))!;
      assert.equal(message.message_thread_id,42);
      const reply = message.reply_parameters;
      assert.ok(reply && typeof reply === 'object' && 'message_id' in reply);
      assert.equal(reply.message_id,target);
    }
    for (const [messageId,entryId,parentEntryId] of [[8000,'old-receipt','old-parent'],[8001,'pending-receipt',missed.id]] as const)
      assert.deepEqual(app.store.getMessageAnchor(sessionId,binding.sessionId,chatId,messageId),{
        ompSessionId:binding.sessionId,entryId,parentEntryId,kind:'collab-prompt',partIndex:0,
      });
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM prompt_submissions WHERE session_id=?').get(sessionId)!.count,0);
    assert.equal(app.store.getReplyTarget(sessionId),8001);
    assert.deepEqual(app.accepted,[]);
    app.emit({t:'entry',entry:known});
    app.emit({t:'entry',entry:duplicate});
    const live = answer('new-live-output',acceptedOutput.id,'Previously delivered');
    app.emit({t:'entry',entry:live});
    await eventually(() => anchors().length === 3);
    assert.deepEqual(anchors().map(row => row.entry_id),[missed.id,acceptedOutput.id,live.id]);
    app.disconnect();
    await app.service.ensureMirroring(session,binding);
    const afterReplay = answer('after-replay',live.id,'Still connected');
    app.emit({t:'entry',entry:afterReplay});
    await eventually(() => anchors().length === 4);
    assert.deepEqual(anchors().map(row => row.entry_id),[missed.id,acceptedOutput.id,live.id,afterReplay.id]);
    assert.deepEqual(app.accepted,[]);
  } finally { await app.close(); }
});
