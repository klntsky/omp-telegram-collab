import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';
import { botId, chatId } from './telegram-data.js';

const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
const runningIcon = '5312016608254762256';

for (const scenario of ['baseline correction', 'independent icon progress'] as const) {
  test(`held temporary title permits ${scenario}`, { timeout: 15000 }, async () => {
    const app = await createSmokeApp();
    const release = Promise.withResolvers<void>();
    let entered = false;
    try {
      await app.update({ text: '/setup' });
      await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Readable title' } });
      const session = app.store.listSessions(botId)[0]!;
      await app.service.ensureMirroring(session, await app.runtime.ensure(session));
      await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
      await eventually(
        () => app.remoteTopics.get(`${chatId}:42`)?.icon_custom_emoji_id === '5408906741125490282',
      );
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (
          method === 'editForumTopic' &&
          'name' in payload &&
          payload.name === 'temporary Readable title'
        ) {
          entered = true;
          await release.promise;
        }
        return previous(method, payload, signal);
      });
      app.topicTitleStatuses.set(session.id, { worktree: false, branch: 'temporary' });
      app.emit({ t: 'state', state });
      await eventually(() => entered);
      if (scenario === 'independent icon progress') {
        app.emit({ t: 'state', state: { ...state, isStreaming: true } });
        await eventually(
          () => app.remoteTopics.get(`${chatId}:42`)?.icon_custom_emoji_id === runningIcon,
        );
        assert.equal(app.remoteTopics.get(`${chatId}:42`)?.name, 'Readable title');
      } else {
        app.topicTitleStatuses.set(session.id, { worktree: false });
        app.emit({ t: 'state', state });
        await setImmediate();
        release.resolve();
        await eventually(() =>
          app.topicEdits.some((edit) => edit.name === 'temporary Readable title'),
        );
        await eventually(() => app.remoteTopics.get(`${chatId}:42`)?.name === 'Readable title');
        assert.equal(app.store.getSession(session.id)?.name, 'Readable title');
      }
      assert.deepEqual(app.accepted, []);
    } finally {
      release.resolve();
      await app.close();
    }
  });
}
