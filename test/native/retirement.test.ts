import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CollabConnection, TopicSession } from '../../shared/contracts.js';
import { emptyConfig, writeConfig } from '../../src/config.js';
import { OmpRuntime } from '../../src/runtime.js';
import { bounded, waitUntil } from '../e2e/helpers/async.js';
import { setupOmpEnvironment } from '../e2e/helpers/omp-environment.js';

// Permanent: a finished main turn can still own a running native background job.
// Idle retirement must inspect that work rather than infer safety from streaming
// state; foreground-question draining tests leave the main turn active instead.
test('idle retirement does not fence a native session waiting for its background job', { timeout: 180000 }, async t => {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await bounded(Promise.resolve().then(close), AbortSignal.timeout(30000)); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('\n'));
  });
  const prompt = 'Start the background retirement guard task.';
  const omp = await setupOmpEnvironment({
    signal: t.signal, diagnostic: t.diagnostic.bind(t),
    after: ((close: () => unknown | Promise<unknown>) => { cleanup.push(close); }) as TestContext['after'],
  }, { tools: ['bash'], scenarios: [{ name: 'retirement-background', prompt, steps: [
    { type: 'tool', id: 'call_retirement_background', name: 'bash', arguments: {
      i: 'Holding native background work', command: 'printf started > retirement-job-started; while :; do sleep 1; done',
      timeout: 0, async: true,
    } },
    { type: 'text', text: 'The background task is running.' },
  ] }] });
  const config = emptyConfig(join(omp.dataDir, 'config.yaml'));
  config.dataDir = omp.dataDir;
  config.instances = [{ id: 1, defaultDir: omp.workspace, chats: [] }];
  config.omp = { executable: omp.executable, args: [...omp.args, '--no-skills'], maxSessions: 1, startupTimeoutMs: 60000 };
  writeConfig(config);
  const session: TopicSession = {
    id: randomUUID(), instanceId: 1, botId: 1, chatId: 1, threadId: 1,
    cwd: omp.workspace, name: 'Native retirement guard', runtime: { kind: 'managed' }, status: 'open', createdAt: Date.now(),
  };
  const runtime = new OmpRuntime(config);
  cleanup.push(async () => { try { await runtime.kill(session); } finally { await runtime.close(); } });
  const binding = await runtime.ensure(session);
  const host = (await omp.listHosts()).find(value => value.sessionId === binding.sessionId)!;
  assert.ok(host);
  const ended = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(error => omp.log('native.retirement.failure', { error: String(error) }));
  let connection: CollabConnection | undefined;
  let closing = false;
  cleanup.push(() => { closing = true; connection?.close(); });
  connection = await runtime.connectCollab(binding, 'Native retirement guard', {
    onFrame(frame) {
      runtime.observeFrame(session.id, frame);
      if (frame.t === 'event' && frame.event.type === 'agent_end') ended.resolve();
      if (frame.t === 'error') failed.reject(new Error(frame.message));
    },
    onClose(reason) { if (!closing) failed.reject(new Error(reason)); },
  }, t.signal);
  runtime.markPrompt(session.id);
  connection.send({ t: 'prompt', text: prompt });
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(60000)]);
  await bounded(Promise.race([ended.promise, failed.promise, omp.provider.failure]), signal);
  // Async admission acknowledges before the shell starts. Wait for its actual
  // side effect before asking whether background work prevents retirement.
  await waitUntil(async () => {
    try { return await readFile(join(session.cwd, 'retirement-job-started'), 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }, value => value === 'started', signal);
  assert.equal(await runtime.retireIdle(0), 0);
  const descriptor = JSON.parse(await readFile(join(omp.dataDir, 'sessions', session.id, 'lifecycle.json'), 'utf8'));
  assert.notEqual(descriptor.retiring, true);
  assert.deepEqual(await runtime.ensure(session), binding);
  await waitUntil(() => omp.listHosts(), hosts => hosts.some(value => value.pid === host.pid), signal);
  omp.provider.assertComplete();
});
