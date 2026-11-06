import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { createProcessKill } from '../src/runtime/process-kill.js';
import type { ManagedHost, RegistryHost } from '../src/runtime/types.js';

test('kill refuses a changed registry generation before signalling the native process', { timeout: 10000 }, async t => {
  const cwd = process.cwd();
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }, { timeout: 5000 });
  await once(child, 'spawn');
  assert.ok(child.pid);
  const expected: RegistryHost = { instanceId: 'kill-identity', sessionId: 'native-session', generation: 1,
    pid: child.pid, cwd, access: 'control', relayConnected: true };
  const observed: RegistryHost = { ...expected, generation: 2 };
  const config: AppConfig = { bots: [], instances: [], configPath: join(tmpdir(), 'unused-kill-config.yaml'),
    dataDir: tmpdir(), publicUrl: '', host: '127.0.0.1', port: 3000,
    omp: { executable: process.execPath, args: [], maxSessions: 1, startupTimeoutMs: 5000 } };
  const session: TopicSession = { id: 'kill-refusal', botId: 1, chatId: -100, threadId: 2, instanceId: 1,
    cwd, name: 'Kill refusal', runtime: { kind: 'attached', instanceId: expected.instanceId, sessionId: expected.sessionId },
    status: 'open', createdAt: Date.now() };
  let firstRead = true;
  const owner = createProcessKill({ config, managed: new Map<string, ManagedHost | null>(),
    // Control only the registry-read race; executable, cwd, ancestry and process lifetime are real.
    async list() { const host = firstRead ? expected : observed; firstRead = false; return [host]; },
    async lifecycle() { return undefined; },
    forgetActivity() { assert.fail('A refused kill must not discard activity ownership'); },
  });
  await assert.rejects(owner.killSession(session), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'OMP host identity changed before kill');
    assert.deepEqual(Reflect.get(error, 'expectedHost'), expected);
    assert.deepEqual(Reflect.get(error, 'observedHost'), observed);
    return true;
  });
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  process.kill(child.pid, 0);
});
