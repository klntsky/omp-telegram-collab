import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { botId, ownerUsername, signedInitData } from './telegram-data.js';
import { GuestClient } from '../web/src/lib/client.js';
import type { GuestTransport } from '../web/src/lib/socket.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected relay state transition');
    await delay(10);
  }
}

for (const username of [ownerUsername, undefined, '']) {
  test(`Mini App identity and topic prompts use authenticated ${username ? 'username' : username === '' ? 'empty-username fallback' : 'numeric identity'}`, async () => {
    const app = await createSmokeApp();
    let socket: WebSocket | undefined;
    try {
      await app.update({ text: '/setup' });
      await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Web prompt destination' } });
      await app.update({ message_thread_id: 43, forum_topic_created: { name: 'Other topic' } });
      const session = app.store.listSessions(botId).find(value => value.threadId === 42)!;
      const initData = signedInitData(session.id, {
        extra: { user: JSON.stringify({ id: 42, first_name: 'Ada', username, is_bot: false }) },
      });
      const response = await fetch(`${app.url}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, sessionId: session.id, initData }),
      });
      assert.equal(response.status, 200);
      const { ticket, displayName } = await response.json() as { ticket: string; displayName: string };
      const participant = username ? `@${username}` : 'user ID 42';
      assert.equal(displayName, participant);
      socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
      let ready = false;
      let promptAuthor: string | undefined;
      socket.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.t === 'snapshot-chunk' && frame.final) ready = true;
        if (frame.t === 'entry' && frame.entry.customType === 'collab-prompt') promptAuthor = frame.entry.details.from;
      });
      await waitFor(() => ready);
      const before = app.messages.length;
      const text = 'Keep <literal> **Markdown** and Unicode 😀 intact.\n@someone_else is not the author.';
      socket.send(JSON.stringify({ t: 'prompt', text }));
      const attribution = username ? `@${username}` : 'Ada (user ID 42)';
      const expected = `${attribution} posted a prompt: ${text}`;
      await waitFor(() => app.messages.some(message => message.text === expected));
      const relayed = app.messages.slice(before).filter(message => String(message.text).includes('posted a prompt:'));
      assert.equal(relayed.length, 1);
      assert.equal(relayed[0]!.text, expected);
      assert.equal(relayed[0]!.chat_id, session.chatId);
      assert.equal(relayed[0]!.message_thread_id, 42);
      assert.equal(relayed[0]!.parse_mode, undefined);
      assert.ok(!app.messages.slice(before).some(message => message.message_thread_id === 43));

      socket.send(JSON.stringify({ t: 'prompt', text: 'Verify Mini App transcript attribution' }));
      await waitFor(() => promptAuthor !== undefined);
      assert.equal(promptAuthor, participant);

      app.setMember(false);
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ t: 'prompt', text: 'This removed member must not be relayed' }));
      await closed;
      assert.ok(!app.messages.some(message => String(message.text).includes('This removed member must not be relayed')));
    } finally {
      socket?.terminate();
      await app.close();
    }
  });
}

for (const username of [ownerUsername, undefined]) {
  test(`confirmed Mini App interruption clears running state and notifies its topic (${username ?? 'numeric identity'})`, async () => {
    const app = await createSmokeApp();
    let client: GuestClient | undefined;
    try {
      await app.update({ text: '/setup' });
      await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Interrupted session' } });
      const session = app.store.listSessions(botId)[0]!;
      const initData = signedInitData(session.id, {
        extra: { user: JSON.stringify({ id: 42, first_name: 'Ada', username, is_bot: false }) },
      });
      const response = await fetch(`${app.url}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, sessionId: session.id, initData }),
      });
      assert.equal(response.status, 200);
      const { ticket, displayName } = await response.json() as { ticket: string; displayName: string };
      const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/api/socket?ticket=${ticket}`, { origin: app.config.publicUrl });
      const transport: GuestTransport = {
        connect() {},
        reconnect() { assert.fail('Unexpected reconnect'); },
        close() { socket.terminate(); },
        send(frame) { socket.send(JSON.stringify(frame)); },
      };
      socket.on('open', () => transport.onOpen?.());
      socket.on('message', data => transport.onFrame?.(JSON.parse(data.toString())));
      client = new GuestClient(transport, displayName);
      client.connect();
      await waitFor(() => client!.getSnapshot().phase === 'live');
      app.emit({ t: 'state', state: { cwd: '/fixture/project', isStreaming: true, isAborting: true, queuedMessageCount: 1, participants: [] } });
      app.emit({ t: 'event', event: { type: 'tool_execution_start', toolCallId: 'interrupted-tool', toolName: 'bash', args: {} } });
      await waitFor(() => client!.getSnapshot().working && client!.getSnapshot().activeTools.has('interrupted-tool'));
      await waitFor(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5312016608254762256');
      const before = app.messages.length;
      client.sendAbort();
      await waitFor(() => app.accepted.some(frame => frame.t === 'abort'));
      assert.ok(!app.messages.slice(before).some(message => String(message.text).includes('interrupted the chat')));
      const author = username ? `@${username}` : 'user ID 42';
      app.emit({ t: 'event', event: { type: 'notice', level: 'info', source: 'extension', message: `${author} interrupted` } });
      await delay(30);
      assert.equal(client.getSnapshot().working, true, 'unrelated notices cannot confirm an interruption');
      app.emit({ t: 'event', event: { type: 'notice', level: 'info', source: 'collab', message: `${author} interrupted` } });
      await waitFor(() => app.messages.some(message => message.text === `⛔️${author} interrupted the chat`));
      await waitFor(() => !client!.getSnapshot().working);
      const snapshot = client.getSnapshot();
      assert.equal(snapshot.state?.isStreaming, false);
      assert.equal(snapshot.state?.isAborting, false);
      assert.equal(snapshot.state?.queuedMessageCount, 0);
      assert.equal(snapshot.activeTools.size, 0);
      await waitFor(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5237699328843200968');
      assert.equal(await app.runtime.isRunning(session), true);
      const notices = app.messages.slice(before).filter(message => String(message.text).includes('interrupted the chat'));
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.chat_id, session.chatId);
      assert.equal(notices[0]!.message_thread_id, session.threadId);
      assert.equal(notices[0]!.parse_mode, undefined);
      app.emit({ t: 'event', event: { type: 'agent_start' } });
      await waitFor(() => client!.getSnapshot().working);
      await waitFor(() => app.topicEdits.at(-1)?.icon_custom_emoji_id === '5312016608254762256');
    } finally {
      client?.close();
      await app.close();
    }
  });
}
