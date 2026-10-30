import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, chatId, ownerId, ownerUsername } from './telegram-data.js';
import { writeConfig } from '../src/config.js';

const owner = { id: ownerId, first_name: 'Ada', username: ownerUsername, is_bot: false };

for (const status of ['creator', 'administrator'] as const) {
  test(`${status} without a username can enroll, attach, and control the Mini App`, async () => {
    const app = await createSmokeApp();
    try {
      app.setCurrentMember({ status });
      await app.update({ text: '/setup' }, { ...owner, username: 'stale_name' });
      assert.equal(app.store.isEnrolled(botId, chatId), true);
      await app.update({ text: '/attach local-instance Native administrator' });
      const session = app.store.listSessions(botId)[0]!;
      assert.deepEqual(session.runtime, { kind: 'attached', instanceId: 'local-instance', sessionId: 'attached-conversation' });
      assert.equal(await app.service.authorizeSession(session, ownerId), true);
      app.setCurrentMember({ status: 'member', username: ownerUsername });
      assert.equal(await app.service.authorizeSession(session, ownerId), false);
      await app.update({ text: '/attach second-instance Revoked administrator' });
      assert.equal(app.store.listSessions(botId).length, 1);
    } finally { await app.close(); }
  });
}

for (const member of [
  { status: 'member' as const, username: ownerUsername },
  { status: 'administrator' as const, username: ownerUsername, is_bot: true },
  { status: 'creator' as const, is_bot: true },
]) {
  test(`setup rejects ${member.is_bot ? 'bot' : 'human'} ${member.status} despite the update identity`, async () => {
    const app = await createSmokeApp();
    try {
      app.setCurrentMember(member);
      await app.update({ text: '/setup' }, owner);
      assert.equal(app.store.isEnrolled(botId, chatId), false);
      assert.deepEqual(app.store.listSetupRequests(), []);
    } finally { await app.close(); }
  });
}

test('ordinary members retain viewing access but cannot create sessions by default', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/setup' });
    app.setCurrentMember({ status: 'member' });
    await app.service.authorize(chatId, ownerId);
    await app.update({ text: '/new Unauthorized task' });
    assert.deepEqual(app.store.listSessions(botId), []);
    app.setMember(false);
    await assert.rejects(app.service.authorize(chatId, ownerId));
  } finally { await app.close(); }
});

test('current owner authority cannot bypass the assigned bot, chat, or project', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({ status: 'creator' });
    await app.update({ text: '/setup' });
    await app.update({ text: '/attach local-instance Assigned session' });
    const session = app.store.listSessions(botId)[0]!;
    assert.equal(await app.service.authorizeSession(session, ownerId), true);
    await assert.rejects(app.service.authorizeSession({ ...session, botId: botId + 1 }, ownerId));
    await assert.rejects(app.service.authorizeSession({ ...session, chatId: chatId - 1 }, ownerId));
    await assert.rejects(app.service.authorizeSession({ ...session, instancePath: `${session.instancePath}/other` }, ownerId));
    app.config.instances[session.instancePath]!.chats = [];
    await assert.rejects(app.service.authorizeSession(session, ownerId));
  } finally { await app.close(); }
});

test('owner revocation during forum readiness prevents enrollment', async () => {
  const app = await createSmokeApp();
  try {
    app.setCurrentMember({ status: 'creator' });
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      const result = await previous(method, payload, signal);
      if (method === 'getChat') app.setCurrentMember({ status: 'member' });
      return result;
    });
    await app.update({ text: '/setup' });
    assert.equal(app.store.isEnrolled(botId, chatId), false);
  } finally { await app.close(); }
});

test('private onboarding is available without a configured username and exposes no project paths', async () => {
  const app = await createSmokeApp();
  try {
    await app.update({ text: '/start', chat: { id: ownerId, type: 'private', first_name: 'Visitor' } }, { ...owner, username: undefined });
    assert.ok(app.messages.at(-1)?.reply_markup);
    for (const path of Object.keys(app.config.instances)) assert.equal(String(app.messages.at(-1)?.text).includes(path), false);
    const before = app.messages.length;
    await app.update({ text: '/start', chat: { id: ownerId, type: 'private', first_name: 'Bot' } }, { ...owner, is_bot: true });
    assert.equal(app.messages.length, before);
  } finally { await app.close(); }
});

for (const status of ['creator', 'administrator'] as const) {
  test(`unassigned ${status} without a username requests setup but cannot assign a project`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-operator-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = await createSmokeApp();
    try {
      const originalPath = Object.keys(app.config.instances)[0]!;
      app.config.instances = {};
      app.config.configPath = join(directory, 'config.yaml');
      writeConfig(app.config);
      app.setCurrentMember({ status: 'member', username: ownerUsername });
      await app.update({ text: '/setup' });
      assert.deepEqual(app.store.listSetupRequests(), []);
      app.setCurrentMember({ status });
      await app.update({ text: '/setup' });
      const request = app.store.listSetupRequests()[0]!;
      assert.equal(request.userId, ownerId);
      assert.equal(request.username, undefined);
      assert.equal(app.store.isEnrolled(botId, chatId), false);
      await app.update({ text: '/new Not locally approved' });
      assert.deepEqual(app.store.listSessions(botId), []);
      assert.deepEqual(app.config.instances, {});
      app.config.instances = { [originalPath]: { chats: [{ botId, chatId }] } };
      writeConfig(app.config);
      app.store.consumeSetupRequest(request.code);
      await app.update({ text: '/setup' });
      assert.equal(app.store.isEnrolled(botId, chatId), true);
      await app.update({ text: '/attach local-instance Approved path task' });
      assert.equal(app.store.listSessions(botId)[0]?.instancePath, originalPath);
    } finally { await app.close(); }
  });
}

test('unbound setup checks bot forum permissions before creating a pending request', async () => {
  const app = await createSmokeApp({ botCanPinMessages: false });
  try {
    app.config.instances = {};
    await app.update({ text: '/setup' });
    assert.deepEqual(app.store.listSetupRequests(), []);
    assert.equal(app.store.isEnrolled(botId, chatId), false);
  } finally { await app.close(); }
});
