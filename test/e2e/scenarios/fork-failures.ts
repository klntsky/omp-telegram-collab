import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeConfig } from '../../../src/config.js';
import { setupCollaborationTest } from '../helpers/collaboration-fixture.js';
import { startCollaborationProcess } from '../helpers/application-process.js';
import { enrollForum } from '../helpers/telegram-actions.js';
import { completeWriteTask, createWriteTask, readSessionHistory, writeScenario } from '../helpers/model-tasks.js';
import test from 'node:test';

export function registerForkFailures(): void {
test('Telegram fork failures preserve completed forks and reject interrupted preparation', { timeout: 480000 }, async t => {
  const seed = createWriteTask('fork-failure-seed');
  const recovery = createWriteTask('fork-notification-recovery');
  const probe = createWriteTask('fork-interruption-probe');
  const app = await setupCollaborationTest(t, { scenarios: [seed, recovery, probe].map(writeScenario) });
  await enrollForum(app);
  const initial = await app.sendAndWait(`/new ${seed.prompt}`);
  await completeWriteTask(app, seed, initial);
  await app.waitForCondition(() => app.hostFrames.some(frame => frame.t === 'event' && frame.event.type === 'agent_end'));
  const source = app.store.listSessions(app.telegram.bot.id)[0]!;
  const sourceHistory = await readSessionHistory(app.omp.dataDir, source.id);
  const bindingPath = join(app.omp.dataDir, 'sessions', source.id, 'binding.json');
  const sourceBinding = await readFile(bindingPath, 'utf8');
  assert.ok(sourceHistory.includes(seed.toolCallId));
  assert.ok(sourceHistory.includes(seed.evidence.nonce));

  await t.test('completed fork survives lost source notification', async () => {
    const existing = new Set(app.store.listSessions(app.telegram.bot.id).map(session => session.id));
    const diagnostic = new Error('E2E transport dropped the delivered final fork source-link response');
    let dropped = false;
    let destinationId: string | undefined;
    let deliveredLink: URL | undefined;
    let intercept = true;
    app.bot.api.config.use(async (previous, method, payload, signal) => {
      if (!intercept || method !== 'sendMessage') return previous(method, payload, signal);
      const request = payload as Parameters<typeof app.bot.api.raw.sendMessage>[0];
      const destination = app.store.listSessions(app.telegram.bot.id).find(session => !existing.has(session.id));
      const link = String(request.text).match(/https:\/\/t\.me\/c\/\d+\/\d+/)?.[0];
      if (!dropped && destination && request.chat_id === source.chatId &&
          request.message_thread_id === source.threadId && link &&
          new URL(link).pathname.endsWith(`/${destination.threadId}`)) {
        assert.ok((await readSessionHistory(app.omp.dataDir, destination.id)).includes(seed.toolCallId));
        assert.ok(await app.runtime.resolveExisting(destination));
        const result = await previous(method, payload, signal);
        dropped = true;
        destinationId = destination.id;
        deliveredLink = new URL(link);
        app.omp.log('fork.notification.dropped-response', { destinationId, payload, result, diagnostic });
        throw diagnostic;
      }
      return previous(method, payload, signal);
    });
    try {
      await app.sendAndWait('/fork', source.threadId);
    } finally {
      intercept = false;
    }
    assert.equal(dropped, true);
    assert.equal(deliveredLink?.protocol, 'https:');
    assert.equal(deliveredLink?.hostname, 't.me');
    const destination = app.store.getSession(destinationId!)!;
    assert.equal(deliveredLink?.pathname, `/c/${String(source.chatId).replace(/^-100/, '')}/${destination.threadId}`);
    assert.deepEqual(app.store.getSession(source.id), source);
    assert.equal(await readSessionHistory(app.omp.dataDir, source.id), sourceHistory);
    assert.equal(await readFile(bindingPath, 'utf8'), sourceBinding);
    const preservedHistory = await readSessionHistory(app.omp.dataDir, destination.id);
    assert.ok(preservedHistory.includes(seed.toolCallId));
    try {
      const target = destination.status === 'open' ? destination : source;
      const sent = await app.sendAndWait(`/p ${recovery.prompt}`, target.threadId);
      await completeWriteTask(app, recovery, sent, target.threadId);
      assert.ok(JSON.stringify(app.omp.provider.requests.get(recovery.name)![0]!.messages).includes(seed.evidence.nonce));
      assert.equal(destination.status, 'open', diagnostic.message);
      assert.equal(await readSessionHistory(app.omp.dataDir, source.id), sourceHistory);
    } finally {
      await app.runtime.kill(destination);
    }
  });

  await t.test('interrupted fork cannot resume with empty history', async child => {
    const before = app.store.getSession(source.id)!;
    app.config.omp.maxSessions = 4;
    writeConfig(app.config);
    await app.pause();
    const history = await readSessionHistory(app.omp.dataDir, source.id);
    const process = await startCollaborationProcess(child, {
      configPath: app.config.configPath, topicActivityEmojis: app.topicActivityEmojis, log: app.omp.log,
    });
    let interruptedId: string | undefined;
    try {
      await app.send('/fork', source.threadId);
      const prepared = await process.forkPrepared;
      assert.equal(prepared.sourceId, source.id);
      interruptedId = prepared.destinationId;
      const directory = join(app.omp.dataDir, 'sessions', interruptedId);
      await assert.rejects(stat(join(directory, 'binding.json')), { code: 'ENOENT' });
      await assert.rejects(stat(join(directory, 'history.jsonl')), { code: 'ENOENT' });
      const scratch = (await readdir(directory)).filter(name => name.startsWith('fork-'));
      assert.ok(scratch.length > 0);
      const nativeHistories = await Promise.all(scratch.map(async name => {
        const path = join(directory, name);
        const files = await readdir(path, { recursive: true });
        return Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => readFile(join(path, file), 'utf8')));
      }));
      assert.ok(nativeHistories.flat().some(contents => contents.includes(seed.toolCallId) && contents.includes(seed.evidence.nonce)));
    } finally {
      const exit = await process.kill();
      assert.equal(exit.signal, 'SIGKILL');
      await app.restart();
    }
    const destination = app.store.getSession(interruptedId!)!;
    assert.ok(destination);
    const sent = await app.sendAndWait(`/p ${probe.prompt}`, destination.threadId);
    const admitted = await stat(join(app.omp.dataDir, 'sessions', destination.id, 'binding.json')).then(
      () => true,
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; },
    );
    if (admitted) {
      await completeWriteTask(app, probe, sent, destination.threadId);
      app.omp.log('fork.interrupted.wrong-context', {
        destinationId: destination.id,
        messages: app.omp.provider.requests.get(probe.name)![0]!.messages,
        history: await readSessionHistory(app.omp.dataDir, destination.id),
      });
    } else {
      const fallback = await app.sendAndWait(`/new ${probe.prompt}`);
      await completeWriteTask(app, probe, fallback);
    }
    assert.deepEqual(app.store.getSession(source.id), before);
    assert.equal(await readFile(bindingPath, 'utf8'), sourceBinding);
    assert.equal(await readSessionHistory(app.omp.dataDir, source.id), history);
    assert.equal(app.store.getSession(destination.id)?.status, 'detached',
      'Interrupted native fork must remain rejected instead of starting a fresh empty conversation');
    assert.equal(admitted, false, 'Interrupted fork must not submit a prompt to an empty native history');
    await assert.rejects(stat(join(app.omp.dataDir, 'sessions', destination.id, 'binding.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(app.omp.dataDir, 'sessions', destination.id, 'history.jsonl')), { code: 'ENOENT' });
  });
});
}
