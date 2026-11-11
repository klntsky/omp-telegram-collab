import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HostFrame, SessionEntry } from '@oh-my-pi/pi-wire';
import { z } from 'zod';
import type { BrowserHostFrame, CollabConnection, TopicSession } from '../../shared/contracts.js';
import { emptyConfig, writeConfig } from '../../src/config.js';
import { OmpRuntime } from '../../src/runtime.js';
import { SessionFeed, type SessionFeedSubscription } from '../../src/session-feed.js';
import { SessionHistory } from '../../src/session-history.js';
import { GuestClient } from '../../web/src/lib/client.js';
import type { GuestTransport } from '../../web/src/lib/socket.js';
import { bounded } from '../e2e/helpers/async.js';
import { createWriteTask, readSessionHistory, writeReadScenario, writeScenario, type WriteTask } from '../e2e/helpers/model-tasks.js';
import { setupOmpEnvironment } from '../e2e/helpers/omp-environment.js';

function readResult(entries: readonly SessionEntry[], task: WriteTask) {
  const entry = entries.find(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === `call_read_${task.name}`);
  assert.ok(entry?.type === 'message' && entry.message.role === 'toolResult');
  assert.equal(entry.message.toolName, 'read');
  assert.equal(entry.message.isError, false);
  return entry;
}

function resultText(entry: SessionEntry): string {
  assert.ok(entry.type === 'message' && entry.message.role === 'toolResult');
  return entry.message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
}

function assertCompleteRead(entry: SessionEntry): void {
  assert.ok(entry.type === 'message' && entry.message.role === 'toolResult');
  const details = z.object({
    totalLines: z.number().positive(),
    summary: z.unknown().optional(),
    truncation: z.object({ truncated: z.boolean().optional() }).optional(),
    meta: z.object({
      truncation: z.unknown().optional(),
      limits: z.object({ columnTruncated: z.boolean().optional() }).optional(),
    }).optional(),
  }).parse(entry.message.details);
  assert.ok(!details.summary && !details.truncation?.truncated &&
    !details.meta?.truncation && !details.meta?.limits?.columnTruncated);
}

test('stock OMP rewrites a watched native read result for warm and newly joined Mini App readers', { timeout: 480000 }, async t => {
  const original = createWriteTask('history-original', '', 'e2e-history-rewrite.txt');
  const replacement = createWriteTask('history-replacement', '', original.path);
  const followup = createWriteTask('history-followup');
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let closing = false;
  t.after(async () => {
    closing = true;
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await bounded(Promise.resolve().then(close), AbortSignal.timeout(30000)); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Native history cleanup failed');
  });
  const omp = await setupOmpEnvironment({
    signal: t.signal,
    diagnostic: t.diagnostic.bind(t),
    after: ((close: () => unknown | Promise<unknown>) => { cleanup.push(close); }) as TestContext['after'],
  }, {
    telegramSecrets: false,
    tools: ['write', 'read'],
    compaction: { enabled: false, supersedeReads: true, dropUseless: false, experimentalContextManagement: false },
    scenarios: [writeReadScenario(original), writeReadScenario(replacement), writeScenario(followup)],
  });
  const failures: unknown[] = [];
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const fail = (error: unknown) => {
    failures.push(error);
    omp.log('native.failure', error);
    failed.reject(error);
  };
  void omp.provider.failure.catch(fail);
  let changed = Promise.withResolvers<void>();
  const notify = () => {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };
  async function waitFor(predicate: () => boolean): Promise<void> {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(60000)]);
    for (;;) {
      signal.throwIfAborted();
      const notification = changed.promise;
      if (failures.length) throw failures[0];
      if (predicate()) return;
      await bounded(Promise.race([notification, failed.promise]), signal);
    }
  }
  const config = emptyConfig(join(omp.dataDir, 'config.yaml'));
  config.dataDir = omp.dataDir;
  config.instances = [{ id: 1, defaultDir: omp.workspace, chats: [] }];
  config.omp = { executable: omp.executable, args: [...omp.args, '--no-skills'], relayUrl: omp.relayUrl, maxSessions: 1, startupTimeoutMs: 60000 };
  writeConfig(config);
  const session: TopicSession = {
    id: randomUUID(), instanceId: 1, botId: 1, chatId: 1, threadId: 1,
    cwd: omp.workspace, name: 'Native history acceptance', runtime: { kind: 'managed' }, status: 'open', createdAt: Date.now(),
  };
  const runtime = new OmpRuntime(config);
  cleanup.push(async () => {
    try { await runtime.kill(session); }
    finally { await runtime.close(); }
  });
  const binding = await runtime.ensure(session);
  const source = await runtime.historySource(session);
  assert.ok(source);
  assert.equal(source.sessionId, binding.sessionId);
  const sourcePath = source.path;
  const initialHosts = (await omp.listHosts()).filter(host => host.sessionId === binding.sessionId);
  assert.equal(initialHosts.length, 1);
  const initialHost = initialHosts[0]!;
  omp.log('native.host.before', initialHost);

  let connection: CollabConnection | undefined;
  const feed = new SessionFeed(frame => {
    assert.ok(connection);
    connection.send(frame);
  });
  cleanup.push(() => feed.close());
  const history = new SessionHistory(feed, {
    sessionId: binding.sessionId,
    source: () => runtime.historySource(session),
    watch: (source, options) => runtime.watchHistory(source, options),
    assertActive() {
      if (closing) throw new Error('Native acceptance session is closing');
    },
    onError: fail,
  });
  cleanup.push(() => history.close());
  await history.prepare();
  const hostFrames: HostFrame[] = [];
  let nativeCloses = 0;
  const native = await runtime.connectCollab(binding, 'Native history acceptance', {
    onFrame(frame) {
      hostFrames.push(frame);
      omp.log('native.host.frame', frame);
      runtime.observeFrame(session.id, frame);
      feed.accept(frame);
      notify();
    },
    onClose(reason) {
      nativeCloses++;
      if (!closing) fail(new Error(`Native connection closed unexpectedly: ${reason}`));
    },
  }, t.signal);
  let refreshCount = 0;
  connection = {
    send: frame => native.send(frame),
    async refreshSnapshot(onFrame) {
      refreshCount++;
      omp.log('native.refresh.start', { refreshCount });
      await native.refreshSnapshot(frame => {
        omp.log('native.refresh.frame', frame);
        onFrame(frame);
      });
      omp.log('native.refresh.end', { refreshCount });
    },
    close: () => native.close(),
  };
  cleanup.push(() => connection!.close());
  await history.start(connection);

  async function runTask(task: WriteTask): Promise<void> {
    const start = hostFrames.length;
    runtime.markPrompt(session.id);
    connection!.send({ t: 'prompt', text: task.prompt });
    await waitFor(() => hostFrames.slice(start).some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
    assert.ok(hostFrames.slice(start).some(frame => frame.t === 'entry' && frame.entry.type === 'message' &&
      frame.entry.message.role === 'assistant' && frame.entry.message.stopReason === 'stop'));
    assert.deepEqual(JSON.parse(await readFile(join(session.cwd, task.path), 'utf8')), task.evidence);
  }
  async function persisted(label: string): Promise<SessionEntry[]> {
    const contents = await readSessionHistory(omp.dataDir, session.id);
    omp.log(`native.history.${label}`, { path: sourcePath, contents });
    return contents.trim().split('\n').map(line => JSON.parse(line));
  }
  async function joinReader(name: string) {
    await history.ensureFresh();
    const frames: BrowserHostFrame[] = [];
    let subscription: SessionFeedSubscription | undefined;
    const transport: GuestTransport = {
      connect() {
        transport.onOpen?.();
        subscription = feed.subscribe({
          onFrame(frame) {
            frames.push(frame);
            omp.log('native.reader.frame', { name, frame });
            transport.onFrame?.(frame);
            notify();
          },
          onClose(reason) { transport.onClose?.(reason, false); },
        });
      },
      reconnect() { throw new Error('Native reader unexpectedly requested reconnection'); },
      close() { subscription?.close(); },
      send(frame) {
        void history.ensureFresh().then(() => {
          assert.ok(subscription);
          return subscription.send(frame);
        }).catch(fail);
      },
    };
    const client = new GuestClient(transport, name);
    cleanup.push(() => client.close());
    client.subscribe(notify);
    client.connect();
    assert.equal(client.getSnapshot().phase, 'live');
    return { client, frames, transport };
  }

  await runTask(original);
  const firstRead = readResult(await persisted('before'), original);
  const originalBody = structuredClone(firstRead.message);
  assert.ok(resultText(firstRead).includes(original.evidence.nonce));
  assertCompleteRead(firstRead);
  const warm = await joinReader('warm-reader');
  const warmRead = readResult(warm.client.getSnapshot().entries, original);
  assert.equal(warmRead.id, firstRead.id);
  assert.deepEqual(warmRead.message.content, originalBody.content);
  const originalEpoch = feed.epoch;
  const refreshesBeforeRewrite = refreshCount;

  await runTask(replacement);
  await waitFor(() => warm.frames.some(frame => frame.t === 'history-reset' &&
    frame.page.entries.some(entry => entry.id === firstRead.id && resultText(entry) !== resultText(firstRead))));
  const after = await persisted('after');
  const rewritten = readResult(after, original);
  assert.equal(rewritten.id, firstRead.id);
  assert.notDeepEqual(rewritten.message, originalBody);
  z.object({ prunedAt: z.number() }).parse(rewritten.message);
  assert.ok(!resultText(rewritten).includes(original.evidence.nonce));
  const latestRead = readResult(after, replacement);
  assert.ok(resultText(latestRead).includes(replacement.evidence.nonce));
  assertCompleteRead(latestRead);
  const reset = warm.frames.findLast(frame => frame.t === 'history-reset');
  assert.ok(reset?.t === 'history-reset');
  assert.deepEqual(readResult(reset.page.entries, original).message.content, rewritten.message.content);
  assert.deepEqual(readResult(warm.client.getSnapshot().entries, original).message.content, rewritten.message.content);
  assert.ok(warm.frames.some(frame => frame.t === 'history-invalidated'));
  assert.ok(refreshCount > refreshesBeforeRewrite);
  assert.notEqual(feed.epoch, originalEpoch);
  assert.equal(warm.client.getSnapshot().history.freshness, 'ready');
  const joined = await joinReader('new-reader');
  assert.deepEqual(readResult(joined.client.getSnapshot().entries, original).message.content, rewritten.message.content);

  const resetsBeforeStaleRequest = warm.frames.filter(frame => frame.t === 'history-reset').length;
  warm.transport.send({ t: 'history-page', reqId: 1000, cursor: { epoch: originalEpoch, before: 0 } });
  await waitFor(() => warm.frames.filter(frame => frame.t === 'history-reset').length > resetsBeforeStaleRequest);
  assert.deepEqual(readResult(warm.client.getSnapshot().entries, original).message.content, rewritten.message.content);

  await runTask(followup);
  await history.ensureFresh();
  const final = await persisted('followup');
  assert.deepEqual(readResult(final, original).message, rewritten.message);
  for (const reader of [warm, joined]) {
    assert.deepEqual(readResult(reader.client.getSnapshot().entries, original).message.content, rewritten.message.content);
    assert.ok(reader.client.getSnapshot().entries.some(entry => entry.type === 'message' &&
      entry.message.role === 'toolResult' && entry.message.toolCallId === followup.toolCallId && !entry.message.isError));
    assert.equal(reader.client.getSnapshot().phase, 'live');
  }
  assert.ok(final.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === followup.toolCallId && !entry.message.isError));
  assert.deepEqual(JSON.parse(await readFile(join(session.cwd, original.path), 'utf8')), replacement.evidence);
  const finalHosts = (await omp.listHosts()).filter(host => host.sessionId === binding.sessionId);
  assert.deepEqual(finalHosts, [initialHost]);
  assert.equal(await runtime.isRunning(session), true);
  assert.equal(nativeCloses, 0);
  assert.deepEqual(failures, []);
  omp.log('native.acceptance.complete', { sessionId: session.id, nativeSessionId: binding.sessionId, pid: initialHost.pid, refreshCount });
  omp.provider.assertComplete();
});
