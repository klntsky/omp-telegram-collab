import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import type { TopicSession } from '../shared/contracts.js';
import { botId, ownerId } from './telegram-data.js';

interface App {
  messages: Record<string, unknown>[];
  update(message: Record<string, unknown>, from?: { id: number; first_name: string; username?: string; is_bot: boolean }): Promise<void>;
  store: { listSessions(botId: number): TopicSession[] };
}
const isoTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

async function status(app: App, threadId?: number, text = '/status', from?: { id: number; first_name: string; username?: string; is_bot: boolean }) {
  const before = app.messages.length;
  await app.update({ text, ...(threadId === undefined ? {} : { message_thread_id: threadId }) }, from);
  const replies = app.messages.slice(before);
  assert.ok(replies.length > 0, 'the command must produce a Telegram reply');
  return replies.map(message => String(message.text)).join('\n');
}

async function topic(app: App, threadId: number, name: string) {
  await app.update({ message_thread_id: threadId, forum_topic_created: { name } });
  const session = app.store.listSessions(botId).find(session => session.threadId === threadId);
  assert.ok(session);
  return session;
}

test('/status observes an empty topic without launching hosts or rediscovering skills', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await topic(app, 42, 'Untouched topic');
    const ensure = t.mock.method(app.runtime, 'ensure', async () => { throw new Error('Status must not launch a host'); });
    const discovery = t.mock.method(app.runtime, 'listSkills', async () => { throw new Error('Status must not discover skills'); });
    const text = await status(app, 42);
    assert.match(text, /Forum:[^\n]*ready/i);
    assert.match(text, /Session:[^\n]*Untouched topic[^\n]*open/i);
    assert.match(text, /Host:[^\n]*stopped/i);
    assert.match(text, /Mirroring:[^\n]*not attached/i);
    assert.match(text, /Latest task:[^\n]*no task observed/i);
    assert.match(text, /Recovery:[^\n]*not scheduled/i);
    assert.match(text, /Skill shortcuts:[^\n]*current/i);
    assert.equal(ensure.mock.callCount(), 0);
    assert.equal(discovery.mock.callCount(), 0);
    assert.equal(app.connectionCount, 0);
    assert.deepEqual(app.accepted, []);
    const general = await status(app);
    assert.match(general, /Forum:[^\n]*ready/i);
    assert.match(general, /Skill shortcuts:/i);
    assert.doesNotMatch(general, /Untouched topic|Host:|Mirroring:|Latest task:/i);
    assert.match(await status(app, 42, '/status unexpected'), /Usage: \/status/);
  } finally { await app.close(); }
});

test('/status preserves accepted tasks with unknown completion when mirroring disconnects', async t => {
  const app = await createSmokeApp({ holdPromptReceipts: true });
  try {
    await app.update({ text: '/setup' });
    const session = await topic(app, 42, 'Accepted task');
    await app.update({ message_thread_id: 42, text: '/p Rejected warm-up' });
    assert.match(await status(app, 42), /Latest task:[^\n]*not accepted/i);
    const accepted = once(app.events, 'accepted');
    await app.update({ message_thread_id: 42, text: '/p Inspect the project' });
    await accepted;
    assert.match(await status(app, 42), /Latest task:[^\n]*waiting for acceptance/i);
    app.emit({ t: 'entry', entry: {
      type: 'custom_message', customType: 'collab-prompt', content: 'Inspect the project',
      details: { from: 'Telegram @FixtureOmpBot' }, display: true, id: 'status-task-receipt', parentId: null,
      timestamp: new Date().toISOString(),
    } });
    app.emit({ t: 'event', event: { type: 'agent_start' } });
    const connected = await status(app, 42);
    assert.match(connected, /Host:[^\n]*running/i);
    assert.match(connected, /Mirroring:[^\n]*connected/i);
    assert.match(connected, /Latest task:[^\n]*accepted/i);
    assert.match(connected, /completion unknown/i);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const connections = app.connectionCount;
    const prompts = app.accepted.filter(frame => frame.t === 'prompt');
    app.disconnect();
    const disconnected = await status(app, 42);
    assert.match(disconnected, /Host:[^\n]*running/i);
    assert.match(disconnected, /Mirroring:[^\n]*disconnected/i);
    assert.match(disconnected, /Latest task:[^\n]*accepted/i);
    assert.match(disconnected, /completion unknown/i);
    assert.match(disconnected, /Recovery:[^\n]*reconnect scheduled/i);
    assert.equal(app.connectionCount, connections);
    assert.deepEqual(app.accepted.filter(frame => frame.t === 'prompt'), prompts);
    assert.equal(await app.runtime.isRunning(session), true);
  } finally {
    t.mock.timers.reset();
    await app.close();
  }
});

test('/status exposes saved skill catalog and original discovery failure, then a successful refresh', async t => {
  const app = await createSmokeApp();
  const diagnostic = 'Skill discovery failed for fixture\n  executable exited with code 17\nOriginal stderr: permission denied';
  try {
    await app.update({ text: '/setup' });
    const discovery = t.mock.method(app.runtime, 'listSkills', async () => { throw new Error(diagnostic); });
    await app.service.refreshSkillCatalogs();
    const failed = await status(app);
    assert.match(failed, /Skill shortcuts:[^\n]*saved catalog/i);
    assert.match(failed, /Last failure/i);
    assert.ok(failed.includes(diagnostic), 'the original multiline discovery diagnostic remains intact');
    assert.match(failed, /skill|discover/i);
    assert.match(failed, isoTimestamp);
    assert.equal(discovery.mock.callCount(), 1, 'status does not retry failed discovery');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    discovery.mock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return [{ name: 'restored-skill', description: 'Fresh discovery result' }];
    });
    const refreshing = app.service.refreshSkillCatalogs();
    try {
      await entered.promise;
      assert.match(await status(app), /Skill shortcuts:[^\n]*refreshing/i);
    } finally {
      release.resolve();
      await refreshing;
    }
    const refreshed = await status(app);
    assert.match(refreshed, /Skill shortcuts:[^\n]*current/i);
    assert.match(refreshed, /(?:refresh|success)[^\n]*\d{4}-\d{2}-\d{2}T/i);
    assert.equal(discovery.mock.callCount(), 2);
    assert.equal(app.connectionCount, 0);
  } finally { await app.close(); }
});

test('/status isolates session runtime failures and continues reporting other status fields', async t => {
  const app = await createSmokeApp();
  const diagnostic = 'Cannot inspect runtime\n  process table unavailable\nOriginal runtime diagnostic';
  try {
    await app.update({ text: '/setup' });
    const broken = await topic(app, 42, 'Broken observation');
    const healthy = await topic(app, 43, 'Separate session');
    const isRunning = app.runtime.isRunning.bind(app.runtime);
    t.mock.method(app.runtime, 'isRunning', async (session: TopicSession) => {
      if (session.id === broken.id) throw new Error(diagnostic);
      return isRunning(session);
    });
    const failed = await status(app, broken.threadId);
    assert.match(failed, /Host:[^\n]*unknown/i);
    assert.match(failed, /Session:[^\n]*Broken observation/i);
    assert.match(failed, /Mirroring:/i);
    assert.match(failed, /Skill shortcuts:/i);
    assert.match(failed, /Last failure/i);
    assert.ok(failed.includes(diagnostic));
    assert.match(failed, isoTimestamp);
    const isolated = await status(app, healthy.threadId);
    assert.match(isolated, /Session:[^\n]*Separate session/i);
    assert.match(isolated, /Host:[^\n]*stopped/i);
    assert.doesNotMatch(isolated, /Broken observation|process table unavailable|Original runtime diagnostic/);
    assert.doesNotMatch(await status(app), /Broken observation|Separate session|Original runtime diagnostic/);
    assert.equal(app.connectionCount, 0);
  } finally { await app.close(); }
});

test('/status permits current non-admin humans but denies departed members', async () => {
  const app = await createSmokeApp();
  const member = { id: ownerId + 1, first_name: 'Member', username: 'ordinary_member', is_bot: false };
  try {
    await app.update({ text: '/setup' });
    await topic(app, 42, 'Members can inspect');
    app.setCurrentMember({ username: member.username, status: 'member' });
    assert.match(await status(app, 42, '/status', member), /Session:[^\n]*Members can inspect/i);
    app.setMember(false);
    const denied = await status(app, 42, '/status', member);
    assert.match(denied, /access denied|current.*member|membership/i);
    assert.doesNotMatch(denied, /Members can inspect|Host:|Skill shortcuts:/i);
  } finally { await app.close(); }
});

test('/status remains available to current members while the service is terminated', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    await topic(app, 42, 'Suspended session');
    await app.update({ text: '/terminate' });
    const member = { id: ownerId + 1, first_name: 'Member', username: 'ordinary_member', is_bot: false };
    app.setCurrentMember({ username: member.username, status: 'member' });
    const text = await status(app, 42, '/status', member);
    assert.match(text, /terminated|suspended/i);
    assert.match(text, /Session:[^\n]*Suspended session/i);
    assert.match(text, /Host:/i);
    assert.match(text, /Skill shortcuts:/i);
    assert.equal(app.connectionCount, 0);
    app.setMember(false);
    const denied = await status(app, 42, '/status', member);
    assert.doesNotMatch(denied, /Suspended session|Host:|Skill shortcuts:/i);
  } finally { await app.close(); }
});

test('/status reports unknown acceptance after an unconfirmed prompt loses its mirror', async t => {
  const app = await createSmokeApp({holdPromptReceipts:true});
  try {
    await app.update({text:'/setup'});
    await topic(app,42,'Unconfirmed admission');
    await app.update({message_thread_id:42,text:'/p Consume startup rejection'});
    await app.update({message_thread_id:42,text:'/p Receipt not observed'});
    assert.match(await status(app,42),/Latest task:[^\n]*waiting for acceptance/i);
    t.mock.timers.enable({apis:['setTimeout']});
    app.disconnect();
    const text = await status(app,42);
    assert.match(text,/Latest task:[^\n]*acceptance unknown/i);
    assert.match(text,/Host:[^\n]*running/i);
    assert.match(text,/Mirroring:[^\n]*disconnected/i);
    assert.ok(text.includes('Fixture relay disconnected'));
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('/status preserves long Unicode diagnostics across Telegram-sized replies', async t => {
  const app = await createSmokeApp();
  try {
    await app.update({text:'/setup'});
    const diagnostic = ('Original diagnostic 🚫 <path> & token\n').repeat(160);
    t.mock.method(app.runtime,'listSkills',async () => { throw new Error(diagnostic); });
    await app.service.refreshSkillCatalogs();
    const before = app.messages.length;
    await app.update({text:'/status'});
    const replies = app.messages.slice(before).map(message=>String(message.text));
    assert.ok(replies.every(text=>text.length<=4096));
    assert.ok(replies.join('').includes(diagnostic));
  } finally { await app.close(); }
});
