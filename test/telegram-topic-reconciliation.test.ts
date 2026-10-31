import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';
import type { BotService, RuntimeLike } from '../src/bot.js';
import type { Store } from '../src/store.js';
import { botId, chatId } from './telegram-data.js';

const idle = {
  cwd: '/fixture/project',
  isStreaming: false,
  queuedMessageCount: 0,
  participants: [],
};
const runningIcon = '5312016608254762256';
const finishIcon = '5408906741125490282';
const remoteKey = `${chatId}:42`;

interface ReconciliationApp {
  update(message: Record<string, unknown>): Promise<void>;
  store: Store;
  service: BotService;
  runtime: Pick<RuntimeLike, 'ensure'>;
  remoteTopics: Map<string, { name: string; icon_custom_emoji_id: string }>;
  topicEdits: Record<string, unknown>[];
}

async function liveTopic(app: ReconciliationApp) {
  await app.update({ text: '/setup' });
  await app.update({
    message_thread_id: 42,
    forum_topic_created: { name: 'Reconciliation probe' },
  });
  const session = app.store.listSessions(botId)[0]!;
  await app.service.ensureMirroring(session, await app.runtime.ensure(session));
  await eventually(
    () =>
      app.topicEdits.some(
        (edit) => edit.message_thread_id === 42 && edit.icon_custom_emoji_id === finishIcon,
      ) && app.remoteTopics.get(remoteKey)?.icon_custom_emoji_id === finishIcon,
  );
  await eventually(() =>
    app.topicEdits.some(
      (edit) => edit.message_thread_id === 42 && edit.name === 'Reconciliation probe',
    ),
  );
  await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
  return session;
}

test(
  '30-second maintenance observes a locally finished host silently becoming streaming',
  { timeout: 15000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const now = Date.now.bind(Date);
    let offset = 0;
    t.mock.method(Date, 'now', () => now() + offset);
    let streaming = false;
    let reads = 0;
    const app = await createSmokeApp({
      readState: async () => {
        reads++;
        return { ...idle, isStreaming: streaming };
      },
    });
    try {
      const session = await liveTopic(app);
      const initialReads = reads;
      streaming = true;
      offset = 30_000;
      t.mock.timers.tick(30_000);
      await eventually(() => reads > initialReads);
      await eventually(() => app.remoteTopics.get(remoteKey)?.icon_custom_emoji_id === runningIcon);
      assert.equal(app.store.getSession(session.id)?.status, 'open');
      assert.equal(await app.runtime.isRunning(session), true);
      assert.deepEqual(app.accepted, []);
    } finally {
      t.mock.timers.reset();
      await app.close();
    }
  },
);

test(
  'anonymous finish echo preserves custom preference and restores it after activity finishes',
  { timeout: 15000 },
  async () => {
    const app = await createSmokeApp();
    try {
      const session = await liveTopic(app);
      await app.update({
        message_thread_id: 42,
        forum_topic_edited: { icon_custom_emoji_id: 'human-selected-icon' },
      });
      assert.equal(app.store.getTopicFinishIcon(session.id), 'human-selected-icon');
      app.emit({ t: 'state', state: { ...idle, isStreaming: true } });
      await eventually(() => app.remoteTopics.get(remoteKey)?.icon_custom_emoji_id === runningIcon);
      await app.update(
        {
          message_thread_id: 42,
          sender_chat: { id: chatId, type: 'supergroup', title: 'Fixture project' },
          forum_topic_edited: { icon_custom_emoji_id: finishIcon },
        },
        { id: 1087968824, first_name: 'Group', is_bot: true },
      );
      assert.equal(app.store.getTopicFinishIcon(session.id), 'human-selected-icon');
      app.emit({ t: 'state', state: idle });
      await eventually(
        () => app.remoteTopics.get(remoteKey)?.icon_custom_emoji_id === 'human-selected-icon',
      );
      assert.deepEqual(app.accepted, []);
    } finally {
      await app.close();
    }
  },
);

test(
  'matching self-attributed metadata echo neither changes intent nor starts a resend loop',
  { timeout: 15000 },
  async () => {
    const app = await createSmokeApp();
    try {
      const session = await liveTopic(app);
      const metadata = { ...app.remoteTopics.get(remoteKey)! };
      const edits = [...app.topicEdits];
      const preference = app.store.getTopicFinishIcon(session.id);
      await app.update(
        { message_thread_id: 42, forum_topic_edited: metadata },
        { id: botId, first_name: 'OMP', is_bot: true },
      );
      app.emit({ t: 'state', state: idle });
      for (let i = 0; i < 5; i++) await setImmediate();
      assert.deepEqual(app.remoteTopics.get(remoteKey), metadata);
      assert.equal(app.store.getTopicFinishIcon(session.id), preference);
      assert.equal(app.store.getSession(session.id)?.name, 'Reconciliation probe');
      assert.deepEqual(app.topicEdits, edits);
      assert.deepEqual(app.accepted, []);
    } finally {
      await app.close();
    }
  },
);

test(
  'consecutive native renames cannot apply an older host title after the newer intent',
  { timeout: 15000 },
  async (t) => {
    const app = await createSmokeApp();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const appliedFirst = Promise.withResolvers<void>();
    try {
      const session = await liveTopic(app);
      const setTitle = app.runtime.setSessionTitle.bind(app.runtime);
      t.mock.method(
        app.runtime,
        'setSessionTitle',
        async (...args: Parameters<typeof setTitle>) => {
          if (args[1] === 'First edit') {
            entered.resolve();
            await release.promise;
            await setTitle(...args);
            appliedFirst.resolve();
            return;
          }
          await setTitle(...args);
        },
      );
      await app.update({ message_thread_id: 42, forum_topic_edited: { name: 'First edit' } });
      await entered.promise;
      await app.update({ message_thread_id: 42, forum_topic_edited: { name: 'Second edit' } });
      release.resolve();
      await appliedFirst.promise;
      await eventually(() => app.sessionTitles.get(session.id) === 'Second edit');
      await eventually(() => app.remoteTopics.get(remoteKey)?.name === 'Second edit');
      assert.equal(app.store.getPendingSessionTitle(session.id), undefined);
      assert.deepEqual(app.accepted, []);
    } finally {
      release.resolve();
      await app.close();
    }
  },
);

test(
  'native rename is adopted before outgoing edits when Git metadata lookup fails',
  { timeout: 15000 },
  async (t) => {
    const app = await createSmokeApp();
    try {
      const session = await liveTopic(app);
      const edits: Record<string, unknown>[] = [];
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === 'editForumTopic') edits.push({ ...payload });
        return previous(method, payload, signal);
      });
      const failure = new Error('Original Git metadata lookup failure');
      let lookups = 0;
      t.mock.method(app.runtime, 'topicTitleStatus', async () => {
        lookups++;
        throw failure;
      });
      app.remoteTopics.get(remoteKey)!.name = 'Human renamed topic';
      await app.update({
        message_thread_id: 42,
        forum_topic_edited: { name: 'Human renamed topic' },
      });
      await eventually(() => lookups > 0);
      await eventually(() => app.sessionTitles.get(session.id) === 'Human renamed topic');
      app.emit({ t: 'state', state: idle });
      await app.service.ensureMirroring(session, await app.runtime.ensure(session));
      await delay(100);
      assert.equal(app.store.getSession(session.id)?.name, 'Human renamed topic');
      assert.equal(app.remoteTopics.get(remoteKey)?.name, 'Human renamed topic');
      assert.ok(
        edits.every((edit) => edit.name === undefined || edit.name === 'Human renamed topic'),
      );
      assert.deepEqual(app.accepted, []);
    } finally {
      await app.close();
    }
  },
);

test(
  'unchanged host snapshots do not resend topic title or icon after eleven minutes',
  { timeout: 15000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const now = Date.now.bind(Date);
    let offset = 0;
    t.mock.method(Date, 'now', () => now() + offset);
    let reads = 0;
    const app = await createSmokeApp({
      readState: async () => {
        reads++;
        return { ...idle, sessionName: 'Reconciliation probe' };
      },
    });
    try {
      const session = await liveTopic(app);
      await eventually(() =>
        app.topicEdits.some(
          (edit) => edit.message_thread_id === 42 && edit.name === 'Reconciliation probe',
        ),
      );
      const metadata = { ...app.remoteTopics.get(remoteKey)! };
      const requests: Record<string, unknown>[] = [];
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === 'editForumTopic') requests.push({ ...payload });
        return previous(method, payload, signal);
      });
      const initialReads = reads;
      offset = 11 * 60_000;
      t.mock.timers.tick(30_000);
      await eventually(() => reads > initialReads);
      app.emit({ t: 'state', state: { ...idle, sessionName: 'Reconciliation probe' } });
      await app.service.ensureMirroring(session, await app.runtime.ensure(session));
      await delay(100);
      assert.deepEqual(requests, []);
      assert.deepEqual(app.remoteTopics.get(remoteKey), metadata);
    } finally {
      t.mock.timers.reset();
      await app.close();
    }
  },
);
