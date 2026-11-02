import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@mtcute/node';
import { z } from 'zod';
import type { FakeLlmProvider, FakeLlmScenario } from './fake-llm-provider.js';

export interface WriteTask {
  name: string;
  path: string;
  prompt: string;
  toolCallId: string;
  evidence: { executedBy: string; nonce: string };
}
interface TaskWorkflow {
  omp: { workspace: string; provider: FakeLlmProvider };
  telegram: { bot: { id: number }; forum: { chatId: number } };
  waitForReply(options: { replyToMessageId: number; threadId?: number }): Promise<Message>;
}
const requestMessages = z.array(z.object({
  role: z.string(), content: z.unknown(), tool_call_id: z.string().optional(),
}));
const userContent = z.union([z.string(), z.array(z.object({
  type: z.string(), text: z.string().optional(), image_url: z.object({ url: z.string() }).optional(),
}))]);

export function createWriteTask(name: string, suffix = ''): WriteTask {
  const path = `e2e-${name}.json`;
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

export async function completeWriteTask(app: TaskWorkflow, task: WriteTask, sent: Message, threadId?: number): Promise<Message> {
  const reply = await app.waitForReply({ replyToMessageId: sent.id, threadId });
  assert.equal(reply.chat.id, app.telegram.forum.chatId);
  assert.equal(reply.sender.id, app.telegram.bot.id);
  if (threadId !== undefined) assert.equal(reply.replyToMessage?.threadId, threadId);
  assert.deepEqual(JSON.parse(await readFile(join(app.omp.workspace, task.path), 'utf8')), task.evidence);
  const requests = app.omp.provider.requests.get(task.name)!;
  assert.equal(requests.length, 2);
  const messages = requestMessages.parse(requests[1]!.messages);
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
