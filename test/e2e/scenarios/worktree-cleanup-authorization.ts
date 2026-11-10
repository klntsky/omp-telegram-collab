import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { createTelegramTestClient, readTelegramApplicationCredentials } from '../../../scripts/lib/telegram-test-auth.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { bounded } from '../helpers/async.js';
import { resolveTelegramTestEnvFile, withTelegramTestSessionStorage } from '../helpers/telegram-env.js';
import { clickPanel, setTopicClosed, waitForPanel, waitForPanelRetired } from '../helpers/telegram-actions.js';
import { createCleanupWorktree } from '../helpers/worktree-cleanup.js';

export function registerWorktreeCleanupAuthorization(getApp: () => CollaborationTest): void {
  it('cleanup requires current administrator access and binds confirmation to its requesting administrator', async t => {
    const app = getApp();
    const credentials = await withTelegramTestSessionStorage(await resolveTelegramTestEnvFile(), async storage =>
      readTelegramApplicationCredentials(storage.env));
    const participant = createTelegramTestClient(credentials);
    t.after(() => participant.destroy());
    const signal = t.signal;
    const config = await participant.call({ _: 'help.getConfig' }, { abortSignal: signal });
    assert.equal(config.testMode, true);
    // Real test-DC accounts and their DC-derived codes are documented by Telegram:
    // https://core.telegram.org/api/auth#test-accounts (not a mocked authorization response).
    const phoneNumber = `999662${randomInt(10000).toString().padStart(4, '0')}`;
    const sent = await participant.call({
      _: 'auth.sendCode', phoneNumber, apiId: credentials.apiId, apiHash: credentials.apiHash,
      settings: { _: 'codeSettings' },
    }, { abortSignal: signal });
    assert.equal(sent._, 'auth.sentCode');
    assert.ok('length' in sent.type);
    // The server advertises six digits despite the five-digit documentation example.
    // https://github.com/tdlib/td/issues/1652 records the upstream correction.
    let authorization = await participant.call({
      _: 'auth.signIn', phoneNumber, phoneCodeHash: sent.phoneCodeHash, phoneCode: '2'.repeat(sent.type.length),
    }, { abortSignal: signal });
    if (authorization._ === 'auth.authorizationSignUpRequired') {
      authorization = await participant.call({
        _: 'auth.signUp', phoneNumber, phoneCodeHash: sent.phoneCodeHash,
        firstName: 'Cleanup authorization', lastName: 'E2E',
      }, { abortSignal: signal });
    }
    assert.equal(authorization._, 'auth.authorization');
    await participant.notifyLoggedIn(authorization);
    const identity = await participant.getMe();
    assert.notEqual(identity.id, app.telegram.user.account.id);
    assert.equal(identity.isBot, false);
    const owner = app.telegram.user.client;
    const invite = await owner.createInviteLink(app.telegram.forum.chat, { usageLimit: 1 });
    await bounded(participant.joinChat(invite.link), signal);
    // Populate the owner's peer cache from Telegram, rather than inventing an access hash.
    await owner.getChatMembers(app.telegram.forum.chat);
    const member = await app.telegram.api.getChatMember(app.telegram.forum.chatId, identity.id);
    assert.equal(member.status, 'member');

    const { session, target } = await createCleanupWorktree(app);
    let start = app.apiCalls.length;
    await setTopicClosed(app, session, true);
    const offer = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:offer:', start, session.threadId);
    await bounded(clickPanel(app, offer, 0, participant), signal);
    assert.equal(existsSync(target.path), true, 'a non-admin cannot delete the worktree');
    const [unchangedOffer] = await owner.getMessages(app.telegram.forum.chat, [offer.messageId]);
    assert.equal(unchangedOffer?.raw._ === 'message' ? unchangedOffer.raw.replyMarkup?._ : undefined, 'replyInlineMarkup');

    const setAdministrator = async (enabled: boolean) => {
      await owner.editAdminRights({
        chatId: app.telegram.forum.chat, userId: identity.id,
        rights: enabled ? { manageTopics: true } : {},
      });
      assert.equal((await app.telegram.api.getChatMember(app.telegram.forum.chatId, identity.id)).status,
        enabled ? 'administrator' : 'member');
    };
    await setAdministrator(true);
    start = app.apiCalls.length;
    await bounded(clickPanel(app, offer, 0, participant), signal);
    const confirmation = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);

    assert.equal((await app.telegram.api.getChatMember(app.telegram.forum.chatId, app.telegram.user.account.id)).status, 'creator');
    await clickPanel(app, confirmation, 0);
    assert.equal(existsSync(target.path), true, 'a different current administrator cannot confirm');

    await setAdministrator(false);
    await bounded(clickPanel(app, confirmation, 0, participant), signal);
    assert.equal(existsSync(target.path), true, 'revocation between offer and confirmation prevents deletion');

    // Denied attempts must not consume the original administrator's confirmation.
    await setAdministrator(true);
    start = app.apiCalls.length;
    await bounded(clickPanel(app, confirmation, 0, participant), signal);
    await waitForPanelRetired(app, confirmation, start);
    assert.equal(existsSync(target.path), false);
    assert.ok(app.store.getSession(session.id), 'authorization checks preserve the topic session');
    await setAdministrator(false);
  });
}
