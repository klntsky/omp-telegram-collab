import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { OmpRuntime } from '../src/runtime.js';
import { connectCollab } from '../src/collab.js';
import { startLocalRelay } from './local-relay.js';
import { verifyTelegramFlow } from './telegram-smoke.js';
import { verifyEnvironmentCli } from './env-smoke.js';

await verifyEnvironmentCli();
await verifyTelegramFlow();

const dir = await mkdtemp(join(tmpdir(), 'omp-telegram-smoke-'));
const relay = await startLocalRelay();
const config: AppConfig = {
  bots: [], publicUrl: 'http://localhost:3000', host: '127.0.0.1', port: 3000, dataDir: dir,
  omp: {
    executable: process.env.OMP_EXECUTABLE ?? 'omp', cwd: dir,
    args: ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title'],
    maxSessions: 2, startupTimeoutMs: 60_000, relayUrl: relay.url,
  },
};
const session: TopicSession = {
  id: 'RkJQtSOXgS9CFpCqE_BxYg', botId: 123, chatId: -100123, threadId: 7,
  name: 'Local smoke', status: 'open', runtime: { kind: 'managed' }, createdAt: Date.now(),
};
let runtime = new OmpRuntime(config);
try {
  const [first, same] = await Promise.all([runtime.ensure(session), runtime.ensure(session)]);
  assert.ok(first.sessionId);
  assert.equal(same.sessionId, first.sessionId);
  assert.equal(same.instanceId, first.instanceId);
  const competing = new OmpRuntime(config);
  try {
    await assert.rejects(competing.ensure(session), 'a second service cannot write the same session data');
  } finally {
    await competing.close();
  }
  const frames: string[] = [];
  const guest = await connectCollab(first, 'Smoke verifier', {
    onFrame(frame) { frames.push(frame.t); },
    onClose() {},
  });
  assert.ok(frames.includes('welcome'), 'actual OMP host returns an encrypted welcome');
  guest.close();
  const attached = await runtime.attach(first.instanceId);
  assert.equal(attached.sessionId, first.sessionId);
  await runtime.close();
  runtime = new OmpRuntime(config);
  const resumed = await runtime.ensure(session);
  assert.equal(resumed.sessionId, first.sessionId, 'service restart resumes the exact OMP conversation');
  assert.notEqual(resumed.instanceId, first.instanceId, 'resumed conversation belongs to a new OMP process');
  const resumedGuest = await connectCollab(resumed, 'Resume verifier', {
    onFrame(frame) {
      if (frame.t === 'welcome') assert.equal(frame.header.id, first.sessionId);
    },
    onClose() {},
  });
  resumedGuest.close();
  await assert.rejects(connectCollab({ ...resumed, sessionId: 'different-conversation' }, 'Identity verifier', {
    onFrame() { assert.fail('mismatched session data must not reach a consumer'); },
    onClose() {},
  }));
  console.log('PASS actual OMP PTY startup, encrypted guest welcome, host attachment, exact-history restart, and session mismatch denial.');
  console.log('No model prompt or live Telegram API request was sent.');
} finally {
  await runtime.close();
  await relay.close();
  await rm(dir, { recursive: true, force: true });
}
