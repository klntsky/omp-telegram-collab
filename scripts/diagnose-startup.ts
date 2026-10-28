import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, defaultConfigPath } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';
import type { TopicSession } from '../shared/contracts.js';

const originalExec = childProcess.execFile;
childProcess.execFile = new Proxy(originalExec, {
  apply(target, thisArg, args: unknown[]) {
    const argv = args[1];
    const callback = args.at(-1);
    if (Array.isArray(argv) && argv[0] === 'collab' && argv[1] === 'list' && typeof callback === 'function') {
      args[args.length - 1] = (error: childProcess.ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (!error) {
          const registry = JSON.parse(stdout.toString());
          console.log(JSON.stringify({ hosts: registry.hosts.map((host: { instanceId: string; relayConnected: boolean }) => ({ instanceId: host.instanceId, relayConnected: host.relayConnected })) }));
        }
        callback(error, stdout, stderr);
      };
    }
    return Reflect.apply(target, thisArg, args);
  },
});
syncBuiltinESMExports();
const directory = await mkdtemp(join(tmpdir(), 'omp-startup-diagnosis-'));
const config = { ...readConfig(process.argv[2] ?? defaultConfigPath()), dataDir: directory };
const instancePath = Object.keys(config.instances)[0];
if (!instancePath) throw new Error('Configure an instance before diagnosing startup');
const runtime = new OmpRuntime(config);
const session: TopicSession = { id: 'startup-diagnosis', instancePath, botId: 0, chatId: 0, threadId: 0, name: 'Startup diagnosis', status: 'open', runtime: { kind: 'managed' }, createdAt: Date.now() };
const start = Date.now();
try {
  const binding = await runtime.ensure(session);
  assert.ok(binding.sessionId);
  console.log(`PASS real managed startup in ${Date.now() - start} ms.`);
} catch (error) {
  console.error(`FAIL real managed startup in ${Date.now() - start} ms. ${error instanceof Error ? error.message : 'Unknown failure'}`);
  process.exitCode = 1;
} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
