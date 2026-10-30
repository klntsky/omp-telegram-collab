import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
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

async function startupFixture(mode: 'recover' | 'persistent' | 'fatal' | 'identity') {
  const directory = await mkdtemp(join(tmpdir(), 'omp-discovery-startup-'));
  const executable = join(directory, 'omp');
  const statePath = join(directory, 'registry.json');
  const attemptsPath = join(directory, 'attempts.json');
  const startupTimeoutMs = 15000;
  await writeFile(statePath, 'null');
  await writeFile(attemptsPath, '[]');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const attemptsPath = ${JSON.stringify(attemptsPath)};
const mode = ${JSON.stringify(mode)};
if (process.argv[2] !== 'collab') {
  const history = process.argv[process.argv.indexOf('--resume') + 1];
  const session = JSON.parse(fs.readFileSync(history, 'utf8').trim().split('\\n')[0]);
  fs.writeFileSync(statePath, JSON.stringify({instanceId:'fixture-host',sessionId:session.id,generation:7,pid:process.pid,cwd:session.cwd,access:'control',relayConnected:true}));
  require('node:net').createServer(socket => socket.destroy()).listen(${JSON.stringify(join(directory, 'keepalive.sock'))});
} else {
  const host = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (process.argv[3] === 'list') console.log(JSON.stringify({version:1,hosts:host?[host]:[]}));
  else {
    const attempts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));
    attempts.push(Date.now());
    fs.writeFileSync(attemptsPath, JSON.stringify(attempts));
    if (mode === 'persistent' || (mode === 'recover' && attempts.length === 1)) {
      process.stderr.write('error: no active Collab host matches fixture-host\\n'); process.exit(1);
    }
    if (mode === 'fatal') {
      process.stderr.write('error: permission denied for fixture-host\\n'); process.exit(23);
    }
    console.log(JSON.stringify({version:1,instanceId:host.instanceId,generation:mode==='identity'?8:host.generation,access:'control',url:'wss://localhost/r/fixture-room.${Buffer.alloc(48, 1).toString('base64url')}'}));
  }
}
`);
  await chmod(executable, 0o700);
  const config: AppConfig = {
    bots: [], instances: { [directory]: { chats: [] } }, configPath: join(directory, 'config.yaml'),
    publicUrl: 'https://localhost:3000', host: '127.0.0.1', port: 3000, dataDir: directory,
    omp: { executable, args: [], maxSessions: 1, startupTimeoutMs },
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  const session: TopicSession = {
    id: 'topic', botId: 1, chatId: -100, threadId: 2, instancePath: directory,
    name: 'Discovery regression', status: 'open', createdAt: Date.now(), runtime: { kind: 'managed' },
  };
  return {
    runtime, session, executable, startupTimeoutMs,
    async attempts(): Promise<number[]> { return JSON.parse(await readFile(attemptsPath, 'utf8')); },
    async close() {
      const host = JSON.parse(await readFile(statePath, 'utf8')) as { pid: number } | null;
      if (host) {
        try { process.kill(host.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('managed startup retries a discovered host whose first Collab link is not found', async t => {
  const app = await startupFixture('recover');
  t.after(() => app.close());
  const binding = await app.runtime.ensure(app.session);
  assert.equal(binding.instanceId, 'fixture-host');
  assert.equal(binding.generation, 7);
  assert.equal((await app.attempts()).length, 2);
});

test('managed startup preserves the last original not-found diagnostic at its original deadline', async t => {
  const app = await startupFixture('persistent');
  t.after(() => app.close());
  const started = Date.now();
  await assert.rejects(app.runtime.ensure(app.session), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, 1);
    assert.equal((error as Error & { signal: string | null }).signal, null);
    assert.ok(error.message.startsWith(`Command failed: ${app.executable} collab link fixture-host --json\nerror: no active Collab host matches fixture-host\n`));
    return true;
  });
  const attempts = await app.attempts();
  assert.ok(attempts.length > 1);
  assert.ok(Date.now() - started >= app.startupTimeoutMs - 100);
  assert.ok(attempts.at(-1)! - started < app.startupTimeoutMs + 250, 'retries must not extend the original startup deadline');
});

test('managed startup does not retry a nontransient Collab link subprocess failure', async t => {
  const app = await startupFixture('fatal');
  t.after(() => app.close());
  await assert.rejects(app.runtime.ensure(app.session), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, 23);
    assert.ok(error.message.startsWith(`Command failed: ${app.executable} collab link fixture-host --json\nerror: permission denied for fixture-host\n`));
    return true;
  });
  assert.equal((await app.attempts()).length, 1);
});

test('managed startup does not retry a Collab link generation identity mismatch', async t => {
  const app = await startupFixture('identity');
  t.after(() => app.close());
  await assert.rejects(app.runtime.ensure(app.session), /OMP host changed while resolving its capability/);
  assert.equal((await app.attempts()).length, 1);
});
