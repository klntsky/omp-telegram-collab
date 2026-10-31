import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AssistantMessage, HostFrame } from '@oh-my-pi/pi-wire';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { clickSettings, eventually } from './bot-test-helpers.js';
import { botId, chatId } from './telegram-data.js';

const assistant = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant', content, model: 'fixture', timestamp: Date.now(), stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
});
const thinking = assistant([{ type: 'thinking', thinking: 'Considering the task' }]);
const text = assistant([{ type: 'text', text: 'An accumulating response' }]);
const tool = assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file' } }]);
const toolStart: HostFrame = { t: 'event', event: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'file' } } };

interface App {
  messages: Record<string, unknown>[];
  chatActions: Record<string, unknown>[];
  update(message: Record<string, unknown>): Promise<void>;
  callback(data: string, message: Record<string, unknown>): Promise<void>;
  emit(frame: HostFrame): void;
}
async function mode(app: App, choice: number) {
  await app.update({ text: '/settings' });
  await clickSettings(app, 6);
  await clickSettings(app, choice);
}
async function createConnectedApp() {
  const app = await createSmokeApp();
  await app.update({ text: '/setup' });
  await app.update({ message_thread_id: 42, forum_topic_created: { name: 'Typing lifecycle' } });
  const session = app.store.listSessions(botId)[0]!;
  await app.service.ensureMirroring(session, await app.runtime.ensure(session));
  return app;
}
function message(app: App, value: AssistantMessage, type: 'message_start' | 'message_update' | 'message_end' = 'message_update') {
  app.emit({ t: 'event', event: { type, message: value } });
}
function persistedMessage(app: App, value: AssistantMessage) {
  app.emit({t:'entry',entry:{
    type:'message',id:'typing-delivery',parentId:null,timestamp:new Date().toISOString(),message:value,
  }});
  message(app, value, 'message_end');
}
async function remainsStopped(app: App, count: number) {
  await delay(4300);
  assert.equal(app.chatActions.length, count);
}

test('disabled typing stays silent through inference, thinking, tools and assistant text', async () => {
  const app = await createConnectedApp();
  try {
    app.emit({ t: 'event', event: { type: 'agent_start' } });
    message(app, thinking, 'message_start');
    app.emit(toolStart);
    message(app, tool);
    message(app, text);
    await remainsStopped(app, 0);
    app.emit({ t: 'event', event: { type: 'agent_end' } });
  } finally { await app.close(); }
});

test('inference typing covers thinking and tool execution, then agent end stops refreshes', async () => {
  const app = await createConnectedApp();
  try {
    await mode(app, 2);
    app.emit({ t: 'event', event: { type: 'agent_start' } });
    message(app, thinking, 'message_start');
    await eventually(() => app.chatActions.length === 1);
    assert.deepEqual(app.chatActions[0], { chat_id: chatId, action: 'typing', message_thread_id: 42 });
    app.emit(toolStart);
    message(app, tool);
    await delay(4300);
    await eventually(() => app.chatActions.length >= 2);
    app.emit({ t: 'event', event: { type: 'agent_end' } });
    await remainsStopped(app, app.chatActions.length);
  } finally { await app.close(); }
});

test('streaming typing requires assistant text and stops between text messages and tool execution', async () => {
  const app = await createConnectedApp();
  try {
    await mode(app, 1);
    app.emit({ t: 'event', event: { type: 'agent_start' } });
    message(app, thinking, 'message_start');
    app.emit(toolStart);
    message(app, tool);
    await remainsStopped(app, 0);
    message(app, text);
    await eventually(() => app.chatActions.length === 1);
    message(app, text, 'message_end');
    await remainsStopped(app, 1);
    message(app, text, 'message_start');
    await eventually(() => app.chatActions.length === 2);
    app.emit(toolStart);
    await remainsStopped(app, 2);
    message(app, assistant([{ type: 'text', text: '' }]));
    await remainsStopped(app, 2);
  } finally { await app.close(); }
});

for (const ending of ['agent_end', 'drop'] as const) {
  test(`${ending} cancels pending typing while foreground delivery is blocked`, async () => {
    const app = await createConnectedApp();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const session = app.store.listSessions(botId)[0]!;
      await mode(app, 2);
      let block = true;
      app.bot.api.config.use(async (previous, method, payload, signal) => {
        if (block && method === 'sendRichMessage') {
          block = false;
          entered.resolve();
          await release.promise;
        }
        return previous(method, payload, signal);
      });
      persistedMessage(app, text);
      await entered.promise;
      app.emit({ t: 'event', event: { type: 'agent_start' } });
      if (ending === 'agent_end') app.emit({ t: 'event', event: { type: 'agent_end' } });
      else {
        const closing = app.update({ message_thread_id: session.threadId, forum_topic_closed: {} });
        await eventually(() => app.activeConnectionCount === 0);
        release.resolve();
        await closing;
      }
      release.resolve();
      await remainsStopped(app, 0);
    } finally { release.resolve(); await app.close(); }
  });
}

test('a real outgoing same-topic send invalidates queued typing before the send completes', async () => {
  const app = await createConnectedApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await mode(app, 2);
    let block = true;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (block && method === 'sendRichMessage') {
        block = false;
        entered.resolve();
        await release.promise;
      }
      return previous(method, payload, signal);
    });
    persistedMessage(app, text);
    await entered.promise;
    app.emit({ t: 'event', event: { type: 'agent_start' } });
    await app.bot.api.sendMessage(chatId, 'Real delivery', { message_thread_id: 42 });
    release.resolve();
    await delay(1200);
    assert.equal(app.chatActions.length, 0);
    app.emit({ t: 'event', event: { type: 'agent_end' } });
  } finally { release.resolve(); await app.close(); }
});

test('changing typing settings affects an already connected inference', async () => {
  const app = await createConnectedApp();
  try {
    app.emit({ t: 'event', event: { type: 'agent_start' } });
    message(app, thinking);
    await mode(app, 1);
    await remainsStopped(app, 0);
    await mode(app, 2);
    await delay(4300);
    await eventually(() => app.chatActions.length >= 1);
    await mode(app, 0);
    await remainsStopped(app, app.chatActions.length);
  } finally { await app.close(); }
});
