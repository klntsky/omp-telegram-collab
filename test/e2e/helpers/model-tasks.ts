import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@mtcute/node';
import { z } from 'zod';
import type { Store } from '../../../src/store.js';
import type { FakeLlmProvider, FakeLlmScenario } from './fake-llm-provider.js';

export interface WriteTask {
  name: string;
  path: string;
  prompt: string;
  toolCallId: string;
  evidence: { executedBy: string; nonce: string };
}
interface TaskWorkflow {
  omp: { provider: FakeLlmProvider };
  store: Pick<Store, 'getTopic'>;
  telegram: { bot: { id: number }; forum: { chatId: number } };
  waitForTaskStarted(name: string): Promise<void>;
  waitForReply(options: { replyToMessageId: number; threadId?: number }): Promise<Message>;
}
const requestMessages = z.array(z.object({
  role: z.string(), content: z.unknown(), tool_call_id: z.string().optional(),
}));
const userContent = z.union([z.string(), z.array(z.object({
  type: z.string(), text: z.string().optional(), image_url: z.object({ url: z.string() }).optional(),
}))]);

export function createWriteTask(name: string, suffix = '', path = `e2e-${name}.json`): WriteTask {
  const evidence = { executedBy: 'real-omp-write-tool', nonce: randomUUID() };
  return {
    name, path, evidence, toolCallId: `call_e2e_${name}`,
    prompt: `Write ${path} containing ${JSON.stringify(evidence)}.${suffix}`,
  };
}

export function writeScenario(task: WriteTask): FakeLlmScenario {
  return { name: task.name, prompt: task.prompt, steps: [
    { type: 'tool', id: task.toolCallId, name: 'write', arguments: {
      i: 'Writing E2E evidence', path: task.path, content: JSON.stringify(task.evidence),
    } },
    { type: 'text', text: 'The requested file has been written.' },
  ] };
}

export function writeReadScenario(task: WriteTask, readPath = task.path): FakeLlmScenario {
  const scenario = writeScenario(task);
  return { ...scenario, steps: [
    scenario.steps[0]!,
    { type: 'tool', id: `call_read_${task.name}`, name: 'read', arguments: {
      i: 'Reading E2E evidence', path: readPath,
    } },
    ...scenario.steps.slice(1),
  ] };
}

export async function completeWriteTask(app: TaskWorkflow, task: WriteTask, sent: Message, threadId?: number): Promise<Message> {
  await app.waitForTaskStarted(task.name);
  const reply = await app.waitForReply({ replyToMessageId: sent.id, threadId });
  assert.equal(reply.chat.id, app.telegram.forum.chatId);
  assert.equal(reply.sender.id, app.telegram.bot.id);
  if (threadId !== undefined) assert.equal(reply.replyToMessage?.threadId, threadId);
  const actualThreadId = reply.replyToMessage?.threadId;
  assert.ok(actualThreadId);
  const session = app.store.getTopic({ botId: app.telegram.bot.id, destination: {
    kind: 'topic', chatId: app.telegram.forum.chatId, threadId: actualThreadId,
  } });
  assert.ok(session?.runtime.kind === 'managed');
  const cwd = session.cwd;
  assert.deepEqual(JSON.parse(await readFile(join(cwd, task.path), 'utf8')), task.evidence);
  const requests = app.omp.provider.requests.get(task.name)!;
  const messages = requestMessages.parse(requests.at(-1)!.messages);
  assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === task.toolCallId));
  return reply;
}

export function taskInput(provider: FakeLlmProvider, task: WriteTask) {
  const requests = provider.requests.get(task.name)!;
  const messages = requestMessages.parse(requests[0]!.messages);
  const user = messages.findLast(message => message.role === 'user');
  assert.ok(user);
  const content = userContent.parse(user.content);
  if (typeof content === 'string') return { text: content, images: [] as string[] };
  return {
    text: content.flatMap(part => part.text === undefined ? [] : [part.text]).join('\n'),
    images: content.flatMap(part => part.image_url ? [part.image_url.url] : []),
  };
}

export function taskReadResult(provider: FakeLlmProvider, task: WriteTask): unknown {
  const requests = provider.requests.get(task.name)!;
  const messages = requestMessages.parse(requests.at(-1)!.messages);
  const result = messages.find(message => message.role === 'tool' && message.tool_call_id === `call_read_${task.name}`);
  assert.ok(result);
  return result.content;
}

export async function readSessionHistory(dataDir: string, sessionId: string): Promise<string> {
  const binding = z.object({ sessionFile: z.string() }).parse(JSON.parse(
    await readFile(join(dataDir, 'sessions', sessionId, 'binding.json'), 'utf8')));
  return readFile(binding.sessionFile, 'utf8');
}

export function questionStep(name: string, options = ['Local', 'Remote']) {
  // Native ask walks radio fields through select/input on Collab hosts without formDialog:
  // https://github.com/can1357/oh-my-pi/blob/v18.18.6/packages/coding-agent/src/tools/ask.ts (askChoice).
  return { type: 'tool' as const, id: `call_ask_${name}`, name: 'ask', arguments: {
    html: `<form><fieldset><legend>Choose the test destination</legend>${options.map((value, index) => `<label><input type="radio" name="${name}" value="${value}"${index === 0 ? ' checked' : ''}>${value}</label>`).join('')}</fieldset></form>`,
  } };
}

export function questionScenario(task: WriteTask): FakeLlmScenario {
  const scenario = writeScenario(task);
  return { ...scenario, steps: [questionStep(task.name), ...scenario.steps] };
}
