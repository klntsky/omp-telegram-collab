import assert from 'node:assert/strict';
import { it } from 'node:test';
import { realpathSync } from 'node:fs';
import { readConfig, writeConfig } from '../../../src/config.js';
import type { NewTopicPolicy } from '../../../shared/contracts.js';
import type { CollaborationTest } from '../helpers/collaboration-fixture.js';
import { clickPanel, openPanel, waitForPanel, changeTopicClosed } from '../helpers/telegram-actions.js';

export function registerNewTopicPolicy(getApp: () => CollaborationTest): void {
  it('manual topic policy persists choices without admitting disconnected messages or creating extra topics', async () => {
    const app = getApp();
    const botId = app.telegram.bot.id;
    const chatId = app.telegram.forum.chatId;
    // Source-verified reachability, not fabricated updates: TDLib CreateForumTopicQuery
    // consumes messageActionTopicCreate and the Bot API serializes messageForumTopicCreated.
    // https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp
    // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
    const configure = (policy?: NewTopicPolicy) => {
      const config = readConfig(app.config.configPath);
      const chat = config.instances.find(instance => instance.id === 1)!.chats[0]!;
      chat.new_topic_policy = policy;
      chat.all_messages_are_prompts = true;
      writeConfig(config);
    };
    const topicSession = (threadId: number) => app.store.getTopic({ botId, destination: { kind: 'topic', chatId, threadId } });
    const create = async () => {
      const topic = await app.telegram.user.client.createForumTopic({ chatId: app.telegram.forum.chat, title: 'Manual topic policy' });
      await app.waitForMessageHandled(topic.id);
      return topic.id;
    };
    const topicWrites = (start: number, threadId: number, messageId?: number) => app.apiCalls.slice(start).filter(call => {
      if (!['sendMessage', 'createForumTopic', 'editForumTopic', 'setMessageReaction'].includes(call.method)) return false;
      const payload = call.payload as { chat_id?: number; message_thread_id?: number; message_id?: number; reply_parameters?: { message_id?: number } };
      if (payload.chat_id !== chatId) return false;
      // Shared-fixture restart also restores older topics; their maintenance is unrelated.
      return call.method === 'createForumTopic' || payload.message_thread_id === threadId ||
        (messageId !== undefined && (payload.message_id === messageId || payload.reply_parameters?.message_id === messageId));
    });
    const quiet = async (threadId: number) => {
      const calls = app.apiCalls.length;
      const frames = app.guestFrames.length;
      const sessions = app.store.listSessions(botId).map(session => session.id);
      const hosts = await app.omp.listHosts();
      const sent = await app.sendAndWait('An ordinary disconnected conversation', threadId);
      assert.deepEqual(app.store.listSessions(botId).map(session => session.id), sessions);
      assert.deepEqual(app.guestFrames.slice(frames).filter(frame => frame.t === 'prompt'), []);
      assert.deepEqual(await app.omp.listHosts(), hosts);
      assert.deepEqual(topicWrites(calls, threadId, sent.id), []);
      assert.equal(topicSession(threadId), undefined);
      assert.notEqual(app.store.getTopicKind({ botId, chatId, threadId }), 'detached');
    };

    const settings = await openPanel(app, '/settings');
    await clickPanel(app, settings, 8);
    await clickPanel(app, settings, 1);
    assert.equal(readConfig(app.config.configPath).instances[0]!.chats[0]!.new_topic_policy, 'chat-only');
    await clickPanel(app, settings, -1);
    const silentStart = app.apiCalls.length;
    const silent = await create();
    assert.deepEqual(topicWrites(silentStart, silent), []);
    await quiet(silent);
    await app.restart();
    await quiet(silent);

    configure('ask');
    const keepStart = app.apiCalls.length;
    const kept = await create();
    const keepPanel = await waitForPanel(app, 'folder', 'topic-policy:', keepStart, kept);
    await quiet(kept);
    await app.restart();
    await clickPanel(app, keepPanel, 1, false);
    assert.equal(app.store.db.prepare('SELECT state FROM manual_topic_choices WHERE bot_id=? AND chat_id=? AND thread_id=?').get(botId, chatId, kept)?.state, 'kept');
    await clickPanel(app, keepPanel, 0, false);
    await quiet(kept);
    await app.restart();
    await quiet(kept);

    const connectStart = app.apiCalls.length;
    const connected = await create();
    const connectPanel = await waitForPanel(app, 'folder', 'topic-policy:', connectStart, connected);
    await changeTopicClosed(app, connected, true);
    await app.restart();
    await clickPanel(app, connectPanel, 0, false);
    assert.equal(topicSession(connected), undefined);
    assert.equal(app.store.db.prepare('SELECT closed FROM manual_topic_choices WHERE bot_id=? AND chat_id=? AND thread_id=?').get(botId, chatId, connected)?.closed, 1);
    await changeTopicClosed(app, connected, false);
    await app.restart();
    app.store.db.prepare('DELETE FROM groups WHERE bot_id=? AND chat_id=?').run(botId, chatId);
    try {
      await clickPanel(app, connectPanel, 0, false);
      assert.equal(topicSession(connected), undefined);
      assert.equal(app.store.db.prepare('SELECT state FROM manual_topic_choices WHERE bot_id=? AND chat_id=? AND thread_id=?').get(botId, chatId, connected)?.state, 'pending');
    } finally {
      app.store.db.prepare('INSERT INTO groups(bot_id,chat_id) VALUES (?,?)').run(botId, chatId);
    }
    await clickPanel(app, connectPanel, 0, false);
    await app.waitForCondition(() => topicSession(connected) !== undefined);
    const session = topicSession(connected)!;
    assert.equal(session.cwd, realpathSync(app.omp.workspace));
    assert.equal(session.runtime.kind, 'managed');
    assert.equal(app.store.hasPendingInitialTask(session.id), false);
    assert.equal(await app.runtime.isRunning(session), false);
    assert.equal(app.store.db.prepare('SELECT state FROM manual_topic_choices WHERE bot_id=? AND chat_id=? AND thread_id=?').get(botId, chatId, connected)?.state, 'connected');
    await clickPanel(app, connectPanel, 0, false);
    await clickPanel(app, connectPanel, 1, false);
    assert.equal(topicSession(connected)?.id, session.id);
    assert.equal(app.apiCalls.slice(connectStart).some(call => call.method === 'createForumTopic'), false);

    configure();
    const automatic = await create();
    assert.ok(topicSession(automatic));
    assert.equal(await app.runtime.isRunning(topicSession(automatic)!), false);
    configure('agent');
    const explicitAgent = await create();
    assert.ok(topicSession(explicitAgent));
    configure('chat-only');
    const prior = new Set(app.store.listSessions(botId).map(current => current.id));
    await app.sendAndWait('/new /worktree', silent);
    const explicit = app.store.listSessions(botId).find(current => !prior.has(current.id));
    assert.ok(explicit);
    assert.notEqual(explicit.threadId, silent);
    assert.equal(topicSession(silent), undefined);
    assert.notEqual(explicit.cwd, realpathSync(app.omp.workspace));
    assert.equal(
      await app.omp.git(explicit.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      await app.omp.git(app.omp.workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    );
    await app.sendAndWait('/kill', explicit.threadId);
    configure('ask');
    const worktreeConfig = readConfig(app.config.configPath);
    worktreeConfig.instances.find(instance => instance.id === 1)!.chats[0]!.create_topic_worktrees = true;
    writeConfig(worktreeConfig);
    app.setFolderOptions(['.', 'unused-policy-folder']);
    const worktreeStart = app.apiCalls.length;
    const worktreeTopic = await create();
    const worktreePanel = await waitForPanel(app, 'folder', 'topic-policy:', worktreeStart, worktreeTopic);
    const folderStart = app.apiCalls.length;
    await clickPanel(app, worktreePanel, 0, false);
    const folder = await waitForPanel(app, 'folder', 'folder:', folderStart, worktreeTopic);
    assert.equal(topicSession(worktreeTopic), undefined);
    await clickPanel(app, folder, 0, false);
    await app.waitForCondition(() => {
      const current = topicSession(worktreeTopic);
      return current !== undefined && current.cwd !== realpathSync(app.omp.workspace);
    });
    await app.omp.assertWorktree(topicSession(worktreeTopic)!);
    assert.equal(app.apiCalls.slice(worktreeStart).some(call => call.method === 'createForumTopic'), false);
    await app.sendAndWait('/kill', worktreeTopic);
  });
}