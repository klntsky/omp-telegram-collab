import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig } from '../shared/contracts.js';
import { OmpRuntime } from '../src/runtime.js';
import { writeConfig } from '../src/config.js';

const execute = promisify(execFile);

for (const failure of ['missing executable', 'list', 'link'] as const) {
  test(`OMP discovery preserves the original subprocess error for ${failure}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-discovery-error-'));
    const executable = join(directory, 'omp');
    const config: AppConfig = {
      bots: [], instances: {}, configPath: join(directory, 'config.yaml'),
      publicUrl: 'https://localhost:3000', host: '127.0.0.1', port: 3000, dataDir: directory,
      omp: { executable, args: [], maxSessions: 1, startupTimeoutMs: 10000 },
    };
    writeConfig(config);
    const runtime = new OmpRuntime(config);
    try {
      if (failure !== 'missing executable') {
        const host = { instanceId: 'fixture', sessionId: 'session', generation: 1, pid: process.pid,
          cwd: directory, access: 'control', relayConnected: true };
        await writeFile(executable, `#!${process.execPath}\nif (process.argv[3] === ${JSON.stringify(failure)}) {\n  process.stderr.write('Registry 🚫 unavailable: <socket> & permission denied\\nOriginal diagnostic line two\\n');\n  process.exit(23);\n}\nconsole.log(${JSON.stringify(JSON.stringify({ version: 1, hosts: [host] }))});\n`);
        await chmod(executable, 0o700);
      }
      const args = failure === 'link' ? ['collab', 'link', 'fixture', '--json'] : ['collab', 'list', '--json'];
      let original: NodeJS.ErrnoException & { signal?: string };
      try {
        await execute(executable, args, { cwd: directory });
        assert.fail('The discovery command must fail');
      } catch (error) {
        assert.ok(error instanceof Error);
        original = error;
      }
      await assert.rejects(runtime.attach('fixture', directory), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, original.message);
        assert.ok('code' in error);
        assert.equal(error.code, original.code);
        assert.equal('signal' in error ? error.signal : undefined, original.signal);
        return true;
      });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
