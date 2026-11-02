import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';

export type FakeLlmStep =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; arguments: Record<string, unknown> };

export interface FakeLlmScenario {
  name: string;
  prompt: string;
  steps: readonly FakeLlmStep[];
}

const completionMessages = z.array(z.object({
  role: z.string(),
  content: z.unknown(),
  tool_call_id: z.string().optional(),
}));

export interface FakeLlmProvider {
  baseUrl: string;
  apiKey: string;
  requests: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  assertComplete(): void;
  close(): Promise<void>;
}

export async function startFakeLlmProvider(options: {
  scenarios: readonly FakeLlmScenario[];
  log(event: string, data: unknown): void;
}): Promise<FakeLlmProvider> {
  const apiKey = 'fake-e2e-api-key';
  const scenarios = new Map(options.scenarios.map(scenario => [scenario.name, {
    ...scenario, requests: [] as Record<string, unknown>[], nextStep: 0, completed: 0,
  }]));
  if (scenarios.size !== options.scenarios.length) throw new Error('Fake LLM scenario names must be unique');
  const errors: unknown[] = [];
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;

  function recordError(error: unknown): void {
    errors.push(error);
    options.log('fake-llm-error', error);
  }

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const metadata = {
      method: request.method,
      path: request.url,
      headers: { ...request.headers, authorization: request.headers.authorization ? '[REDACTED]' : undefined },
    };
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      options.log('fake-llm-request', { ...metadata, body: rawBody });
      throw error;
    }
    options.log('fake-llm-request', { ...metadata, body });
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Fake LLM protocol error: request body must be a JSON object');
    }
    const payload = body as Record<string, unknown>;
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      throw new Error(`Fake LLM protocol error: unexpected ${request.method} ${request.url}`);
    }
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      throw new Error('Fake LLM protocol error: expected the fake-only bearer API key');
    }
    if (payload.stream !== true) {
      throw new Error('Fake LLM protocol error: stream must be true');
    }
    const messages = completionMessages.parse(payload.messages);
    const userMessage = messages.findLast(message => message.role === 'user');
    const content = JSON.stringify(userMessage?.content);
    const matches = [...scenarios.values()].filter(scenario =>
      content?.includes(JSON.stringify(scenario.prompt).slice(1, -1)));
    if (matches.length !== 1) throw new Error(`Fake LLM expected one scenario for the latest user prompt, matched ${matches.length}: ${content}`);
    const scenario = matches[0]!;
    const step = scenario.steps[scenario.nextStep];
    if (!step) throw new Error(`Fake LLM scenario "${scenario.name}" received an extra completion request`);
    const previous = scenario.steps[scenario.nextStep - 1];
    const last = messages.at(-1);
    if (previous?.type === 'tool' && (last?.role !== 'tool' || last.tool_call_id !== previous.id)) {
      throw new Error(`Fake LLM scenario "${scenario.name}" expected the result of tool call "${previous.id}", received ${JSON.stringify(last)}`);
    }
    scenario.requests.push(payload);
    const index = scenario.nextStep++;
    const id = `chatcmpl-${scenario.name}-${index + 1}`;
    const created = Math.floor(Date.now() / 1000);
    if (typeof payload.model !== 'string' || !payload.model) throw new Error('Fake LLM protocol error: model must be a non-empty string');
    const model = payload.model;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    function emit(data: unknown): void {
      const frame = `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
      options.log('fake-llm-sse', { scenario: scenario.name, index, frame });
      response.write(frame);
    }
    function chunk(delta: Record<string, unknown>, finishReason: string | null = null): void {
      emit({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    }
    chunk({ role: 'assistant', content: '' });
    if (step.type === 'text') {
      chunk({ content: step.text });
    } else {
      const argumentsJson = JSON.stringify(step.arguments);
      const split = Math.max(1, Math.floor(argumentsJson.length / 2));
      chunk({ tool_calls: [{ index: 0, id: step.id, type: 'function', function: { name: step.name, arguments: '' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(0, split) } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(split) } }] });
    }
    chunk({}, step.type === 'tool' ? 'tool_calls' : 'stop');
    emit({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    emit('[DONE]');
    const finished = Promise.withResolvers<void>();
    response.once('error', finished.reject);
    response.once('close', () => {
      if (!response.writableFinished) finished.reject(new Error('Fake LLM response closed before completion'));
    });
    response.end(() => finished.resolve());
    await finished.promise;
    scenario.completed++;
    options.log('fake-llm-response-complete', { scenario: scenario.name, index, id, type: step.type });
  }

  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      recordError(error);
      options.log('fake-llm-unexpected-request', { method: request.method, path: request.url });
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: 'fake_llm_protocol_error' } }));
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (error, socket) => {
    recordError(error);
    socket.destroy();
  });
  server.on('error', recordError);
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake LLM did not bind a loopback TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    requests: new Map([...scenarios].map(([name, scenario]) => [name, scenario.requests])),
    assertComplete() {
      const failures = [...errors];
      for (const scenario of scenarios.values()) {
        if (scenario.completed !== scenario.steps.length || scenario.nextStep !== scenario.steps.length) {
          failures.push(new Error(`Fake LLM scenario "${scenario.name}" incomplete: ${scenario.completed}/${scenario.steps.length} responses completed, ${scenario.nextStep}/${scenario.steps.length} steps consumed`));
        }
      }
      if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
    },
    close() {
      if (!closing) {
        const closed = Promise.withResolvers<void>();
        closing = closed.promise;
        server.close((error) => error ? closed.reject(error) : closed.resolve());
        for (const socket of sockets) socket.destroy();
      }
      return closing;
    },
  };
}
