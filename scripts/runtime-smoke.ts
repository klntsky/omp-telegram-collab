import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../shared/contracts.js';
import { topicDestination } from '../shared/topic-destination.js';
import { OmpRuntime, SessionCapacityError } from '../src/runtime.js';
import { connectCollab } from '../src/collab.js';
import { startLocalRelay } from './local-relay.js';
import { formatCollabLink, parseCollabLink } from '../src/vendor/link.js';
import { verifyBusyHostRetirement } from './host-lifecycle-smoke.js';
import { verifyRuntimeKill } from './runtime-kill-smoke.js';
import { readConfig, writeConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const dir = await mkdtemp(join(tmpdir(), 'omp-telegram-smoke-'));
const relay = await startLocalRelay();
const config: AppConfig = {
  bots: [{ id: 123, token: '123:smoke-token-never-sent-to-telegram', miniAppShortName: 'app' }],
  instances: { [dir]: { chats: [{ botId: 123, chatId: -100123 }] } },
  configPath: join(dir, 'config.yaml'),
  publicUrl: 'https://smoke.example', host: '127.0.0.1', port: 3000, dataDir: dir,
  omp: {
    executable: process.env.OMP_EXECUTABLE ?? 'omp',
    args: ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title'],
    maxSessions: 1, startupTimeoutMs: 60_000, relayUrl: relay.url,
  },
};
writeConfig(config);
const filename = join(dir, 'telegram.sqlite');
const initialStore = new Store(filename);
const session = initialStore.createSession(
  { botId: 123, chatId: -100123, threadId: 7, instancePath: dir },
  'Local smoke', { kind: 'managed' }, 'Preserved pending instruction',
);
initialStore.enrollGroup(session.botId, session.chatId);
initialStore.close();
let runtime = new OmpRuntime(config);
try {
  await runtime.setSessionTitle(session, 'Queued before host startup');
  assert.equal(await runtime.isRunning(session), false, 'a topic rename must not launch OMP');
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
  const titleState = Promise.withResolvers<void>();
  await runtime.setSessionTitle(session, 'Telegram title → actual OMP');
  const controlLink = parseCollabLink(first.url);
  assert.ok(!('error' in controlLink));
  assert.ok(controlLink.writeToken);
  const forgedToken = controlLink.writeToken.slice();
  forgedToken[0] = forgedToken[0]! ^ 1;
  const forgedBinding = {
    ...first,
    url: formatCollabLink(relay.url, controlLink.roomId, controlLink.key, forgedToken),
  };
  await assert.rejects(async () => {
    const unauthorized = await connectCollab(forgedBinding, 'Forged capability verifier', {
      onFrame(frame) {
        assert.notEqual(frame.t, 'welcome', 'a rejected control welcome must not reach the consumer');
        assert.notEqual(frame.t, 'snapshot-chunk', 'a rejected control snapshot must not reach the consumer');
      },
      onClose() {},
    });
    unauthorized.close();
    assert.fail('a valid room key with a forged write token must not obtain a control connection');
  }, /Collab host refused control access/);
  const guest = await connectCollab(first, 'Smoke verifier', {
    onFrame(frame) {
      frames.push(frame.t);
      if (frame.t === 'welcome') assert.equal(frame.state.sessionName, 'Telegram title → actual OMP');
      if (frame.t === 'state' && frame.state.sessionName === 'Live Telegram rename') titleState.resolve();
    },
    onClose() {},
  });
  assert.ok(frames.includes('welcome'), 'actual OMP host returns an encrypted welcome');
  const titleTimer = setTimeout(() => titleState.reject(new Error('Native title rename did not publish collab state')), 10000);
  try {
    await runtime.setSessionTitle(session, 'Live Telegram rename');
    await titleState.promise;
  } finally {
    clearTimeout(titleTimer);
  }
  guest.close();
  console.log('PASS actual OMP denies a forged write capability despite a valid encryption key; the genuine capability still receives the snapshot and live title updates.');
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
      if (frame.t === 'welcome') assert.equal(frame.state.sessionName, 'Live Telegram rename', 'native title persists across a fresh host process');
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
  config.instances[secondPath] = { chats: [{ botId: session.botId, chatId: session.chatId - 1 }] };
  runtime.setSessionLimit(2);
  const secondSession = { ...session, id: 'second-instance-session', chatId: session.chatId - 1, instancePath: secondPath };
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
  const historyBeforeReopen = await readFile(historyPath);
  config.omp.maxSessions = 2;
  writeConfig(config);
  const reopenedConfig = readConfig(config.configPath);
  assert.deepEqual(reopenedConfig.instances[dir]?.chats, [{ botId: session.botId, chatId: session.chatId, all_messages_are_prompts: true, users_can_propose_prompts: false }]);
  assert.deepEqual(await readFile(historyPath), historyBeforeReopen);
  const reopenedStore = new Store(filename);
  runtime = new OmpRuntime(reopenedConfig);
  try {
    await runtime.acquire();
    await runtime.validateSessionPaths(reopenedStore.listSessions());
    const preserved = reopenedStore.getTopic({botId: session.botId, destination: topicDestination(session.chatId, session.threadId)})!;
    assert.deepEqual(preserved, session);
    assert.equal(reopenedStore.hasPendingInitialTask(session.id), true);
    assert.equal(reopenedStore.isEnrolled(session.botId, session.chatId), true);
    const recovered = await runtime.ensure(preserved);
    assert.equal(recovered.sessionId, resumed.sessionId);
    assert.equal(recovered.instanceId, resumed.instanceId, 'a current store/config reopen must recover the protected live host');
    assert.equal(reopenedStore.hasPendingInitialTask(session.id), true, 'recovery must not submit or claim the pending instruction');
    assert.deepEqual(await readFile(historyPath), historyBeforeReopen);
    runtime.observeFrame(session.id, { t: 'event', event: { type: 'agent_end' } });
  } finally {
    await runtime.close();
    reopenedStore.close();
  }
  console.log('PASS current database/config reopen preserves actual OMP history bytes, topic identity, pending task, and live host binding.');
  const worktreeRepository = join(dir, 'worktree-repository');
  await mkdir(worktreeRepository);
  execFileSync('git', ['init', '--quiet', worktreeRepository]);
  await writeFile(join(worktreeRepository, 'tracked'), 'committed\n');
  execFileSync('git', ['-C', worktreeRepository, 'add', 'tracked']);
  execFileSync('git', ['-C', worktreeRepository, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '--quiet', '-m', 'Smoke root']);
  await writeFile(join(worktreeRepository, 'tracked'), 'dirty tracked\n');
  await writeFile(join(worktreeRepository, 'untracked'), 'dirty untracked\n');
  reopenedConfig.instances[worktreeRepository] = { chats: [{ botId: session.botId, chatId: session.chatId - 2 }] };
  runtime = new OmpRuntime(reopenedConfig);
  const worktreeSession = {
    ...session, id: 'worktree-smoke-session', instancePath: worktreeRepository, chatId: session.chatId - 2,
    runtime: { kind: 'managed' as const, worktreePath: undefined as string | undefined },
  };
  try {
    const binding = await runtime.ensure(worktreeSession);
    const nativeOutput = await runtime.worktree(worktreeSession, `telegram-smoke-${Date.now()}`);
    assert.match(nativeOutput, /Moved to worktree/);
    const worktreePath = worktreeSession.runtime.worktreePath!;
    assert.ok(worktreePath);
    assert.equal(await readFile(join(worktreePath, 'tracked'), 'utf8'), 'dirty tracked\n');
    assert.equal(await readFile(join(worktreePath, 'untracked'), 'utf8'), 'dirty untracked\n');
    const moved = await runtime.ensure(worktreeSession);
    assert.equal(moved.sessionId, binding.sessionId);
    const guest = await connectCollab(moved, 'Worktree verifier', {
      onFrame(frame) {
        if (frame.t === 'welcome') assert.equal(frame.header.cwd, worktreePath);
      },
      onClose() {},
    });
    guest.close();
    await runtime.validateSessionPaths([worktreeSession]);
    await runtime.kill(worktreeSession);
    assert.equal(await runtime.isRunning(worktreeSession), false);
    await runtime.close();
    runtime = new OmpRuntime(reopenedConfig);
    await runtime.validateSessionPaths([worktreeSession]);
    const resumed = await runtime.ensure(worktreeSession);
    assert.equal(resumed.sessionId, binding.sessionId);
    await runtime.kill(worktreeSession);
    execFileSync('git', ['-C', worktreeRepository, 'worktree', 'remove', '--force', worktreePath]);
    console.log('PASS native /worktree carries dirty tracked/untracked bytes, retains session identity, and resumes relocated history after runtime restart.');
  } finally {
    await runtime.close();
  }
  await verifyBusyHostRetirement(await mkdtemp(join(dir,'guard-')),config.omp.executable,relay.url);
  await verifyRuntimeKill(await mkdtemp(join(dir,'kill-')),config.omp.executable,relay.url);
  console.log('PASS actual OMP PTY startup, encrypted guest welcome, multiple instance paths, wrong-path attachment denial, capacity rejection, exact-history restart, and session mismatch denial.');
  console.log('No model prompt or live Telegram API request was sent.');
} finally {
  await runtime.close();
  await relay.close();
  await rm(dir, { recursive: true, force: true });
}
