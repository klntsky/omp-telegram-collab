import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { OmpRuntime, SessionCapacityError } from '../src/runtime.js';
import { connectCollab } from '../src/collab.js';
import { startLocalRelay } from './local-relay.js';
import { verifyBusyHostRetirement } from './host-lifecycle-smoke.js';
import { verifyRuntimeKill } from './runtime-kill-smoke.js';
import { migrateLegacy } from '../src/config.js';
import { Store } from '../src/store.js';

const dir = await mkdtemp(join(tmpdir(), 'omp-telegram-smoke-'));
const relay = await startLocalRelay();
const config: AppConfig = {
  bots: [], instances: { [dir]: { admins: [], chats: [] } }, configPath: join(dir, 'config.yaml'),
  publicUrl: 'http://localhost:3000', host: '127.0.0.1', port: 3000, dataDir: dir,
  omp: {
    executable: process.env.OMP_EXECUTABLE ?? 'omp',
    args: ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title'],
    maxSessions: 1, startupTimeoutMs: 60_000, relayUrl: relay.url,
  },
};
const session: TopicSession = {
  id: 'RkJQtSOXgS9CFpCqE_BxYg', botId: 123, chatId: -100123, threadId: 7,
  instancePath: dir,
  name: 'Local smoke', status: 'open', runtime: { kind: 'managed' }, createdAt: Date.now(),
};
let runtime = new OmpRuntime(config);
try {
  const [first, same] = await Promise.all([runtime.ensure(session), runtime.ensure(session)]);
  assert.ok(first.sessionId);
  assert.equal(same.sessionId, first.sessionId);
  assert.equal(same.instanceId, first.instanceId);
  const release = runtime.retain(session.id);
  await assert.rejects(runtime.ensure({ ...session, id: 'capacity-boundary-session' }), SessionCapacityError);
  release();
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
  const attached = await runtime.attach(first.instanceId, dir);
  assert.equal(attached.sessionId, first.sessionId);
  runtime.markPrompt(session.id);
  await runtime.close();
  runtime = new OmpRuntime(config);
  const preserved = await runtime.ensure(session);
  assert.equal(preserved.instanceId,first.instanceId,'service shutdown preserves protected hosts instead of killing their process');
  runtime.observeFrame(session.id,{t:'event',event:{type:'agent_end'}});
  const other = {...session,id:'idle-replacement-session'};
  await runtime.ensure(other);
  assert.equal(await runtime.isRunning(session),false,'capacity pressure retires an unused idle host');
  const resumed = await runtime.ensure(session);
  assert.equal(resumed.sessionId,first.sessionId,'idle retirement preserves the exact OMP conversation');
  assert.notEqual(resumed.instanceId,first.instanceId,'a retired conversation resumes in a fresh process');
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
  const secondPath = join(dir, 'second checkout');
  await mkdir(secondPath);
  config.instances[secondPath] = { admins: [], chats: [] };
  runtime.setSessionLimit(2);
  const secondSession = { ...session, id: 'second-instance-session', instancePath: secondPath };
  const secondBinding = await runtime.ensure(secondSession);
  assert.notEqual(secondBinding.sessionId, resumed.sessionId);
  const secondGuest = await connectCollab(secondBinding, 'Instance path verifier', {
    onFrame(frame) {
      if (frame.t === 'welcome') assert.equal(frame.header.cwd, secondPath);
    },
    onClose() {},
  });
  secondGuest.close();
  await assert.rejects(runtime.attach(secondBinding.instanceId, dir), /instance path/);
  await assert.rejects(runtime.ensure({ ...session, instancePath: secondPath }), /incompatible/);
  assert.equal(await runtime.isRunning(session), true, 'a path mismatch must leave the original host alive');
  assert.equal(await runtime.isRunning(secondSession), true);
  runtime.markPrompt(session.id);
  await runtime.close();
  const historyPath = join(dir, 'sessions', session.id, 'history.jsonl');
  const historyBeforeMigration = await readFile(historyPath, 'utf8');
  const legacy = new DatabaseSync(join(dir, 'telegram.sqlite'));
  legacy.exec('CREATE TABLE groups (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id)); CREATE TABLE sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,initial_task TEXT,initial_state TEXT,UNIQUE(bot_id,chat_id,thread_id));');
  legacy.prepare('INSERT INTO groups VALUES (?,?)').run(session.botId, session.chatId);
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run(session.id, session.botId, session.chatId, session.threadId, session.name, session.status, JSON.stringify(session.runtime), session.createdAt, 'Preserved pending instruction', 'pending');
  legacy.close();
  const migrated = migrateLegacy(join(dir, 'migrated.yaml'), {
    TELEGRAM_BOT_TOKEN: '123:smoke-token-never-sent-to-telegram',
    TELEGRAM_OWNER_USERNAMES: 'smokeadmin',
    PUBLIC_URL: 'https://smoke.example',
    DATA_DIR: dir, OMP_CWD: dir, OMP_EXECUTABLE: config.omp.executable,
    OMP_MAX_SESSIONS: '2', OMP_RELAY_URL: relay.url,
    ...Object.fromEntries(config.omp.args.map((arg, index) => [`OMP_ARG_${index + 1}`, arg])),
  }, dir);
  assert.equal(await readFile(historyPath, 'utf8'), historyBeforeMigration);
  const migratedStore = new Store(join(dir, 'telegram.sqlite'));
  runtime = new OmpRuntime(migrated);
  try {
    await runtime.acquire();
    await runtime.validateSessionPaths(migratedStore.listSessions());
    migratedStore.assignSessionPaths(migrated);
    const preserved = migratedStore.getSession(session.id)!;
    assert.equal(preserved.instancePath, dir);
    assert.equal(migratedStore.hasPendingInitialTask(session.id), true);
    assert.equal(migratedStore.isEnrolled(session.botId, session.chatId), true);
    const recovered = await runtime.ensure(preserved);
    assert.equal(recovered.sessionId, resumed.sessionId);
    assert.equal(recovered.instanceId, resumed.instanceId, 'migration must recover the protected live host');
    assert.equal(await readFile(historyPath, 'utf8'), historyBeforeMigration);
    runtime.observeFrame(session.id, { t: 'event', event: { type: 'agent_end' } });
  } finally {
    await runtime.close();
    migratedStore.close();
  }
  console.log('PASS legacy database/config migration preserves actual OMP history bytes, topic identity, pending task, and live host binding.');
  await verifyBusyHostRetirement(await mkdtemp(join(dir,'guard-')),config.omp.executable,relay.url);
  await verifyRuntimeKill(await mkdtemp(join(dir,'kill-')),config.omp.executable,relay.url);
  console.log('PASS actual OMP PTY startup, encrypted guest welcome, multiple instance paths, wrong-path attachment denial, capacity rejection, exact-history restart, and session mismatch denial.');
  console.log('No model prompt or live Telegram API request was sent.');
} finally {
  await runtime.close();
  await relay.close();
  await rm(dir, { recursive: true, force: true });
}
