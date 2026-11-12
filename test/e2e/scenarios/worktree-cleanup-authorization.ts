import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { forkTelegramTestSession } from '../../../scripts/lib/telegram-test-sessions.js';
import { telegramTestTimeouts, withTelegramTestDeadline } from '../../../scripts/lib/telegram-test-deadline.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { bounded } from '../helpers/async.js';
import { clickPanel, setTopicClosed, waitForPanel, waitForPanelRetired } from '../helpers/telegram-actions.js';
import { createCleanupWorktree } from '../helpers/worktree-cleanup.js';

export function registerWorktreeCleanupAuthorization(getApp: () => CollaborationTest): void {
  it('cleanup requires current administrator access and binds confirmation to its requesting administrator', async t => {
    const app = getApp();
    const signal = t.signal;
    const sessionOwner = await withTelegramTestDeadline('secondary user authorization',
      telegramTestTimeouts.authorization, signal, scope => forkTelegramTestSession(scope, app.telegram.user.account.id));
    t.after(() => sessionOwner.close());
    const participant = sessionOwner.client;
    const identity = await bounded(participant.getMe(), signal);
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
    await bounded(clickPanel(app, offer, 0, true, participant), signal);
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
    await bounded(clickPanel(app, offer, 0, true, participant), signal);
    const confirmation = await waitForPanel(app, 'worktree-cleanup', 'wtcleanup:confirm:', start, session.threadId);

    assert.equal((await app.telegram.api.getChatMember(app.telegram.forum.chatId, app.telegram.user.account.id)).status, 'creator');
    await clickPanel(app, confirmation, 0);
    assert.equal(existsSync(target.path), true, 'a different current administrator cannot confirm');

    await setAdministrator(false);
    await bounded(clickPanel(app, confirmation, 0, true, participant), signal);
    assert.equal(existsSync(target.path), true, 'revocation between offer and confirmation prevents deletion');

    // Denied attempts must not consume the original administrator's confirmation.
    await setAdministrator(true);
    start = app.apiCalls.length;
    await bounded(clickPanel(app, confirmation, 0, true, participant), signal);
    await waitForPanelRetired(app, confirmation, start);
    assert.equal(existsSync(target.path), false);
    assert.ok(app.store.getSession(session.id), 'authorization checks preserve the topic session');
    await setAdministrator(false);
  });
}
