import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureToken = '123456789:fixture-token-not-valid-on-telegram';

export async function verifyEnvironmentCli(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omp-env-cli-'));
  const processEnv = { PATH: process.env.PATH ?? '' };
  const envFile = join(cwd, '.env');
  const cli = join(root, 'dist', 'cli.js');
  const loader = import.meta.resolve('tsx');
  const probe = `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(root, 'src', 'config.ts')).href)}; const c=loadConfig(); console.log(JSON.stringify({owners:c.bots[0].ownerUsernames,port:c.port,publicUrl:c.publicUrl,dataDir:c.dataDir}));`;
  try {
    await writeFile(envFile, `TELEGRAM_BOT_TOKEN=${fixtureToken}\nTELEGRAM_OWNER_USERNAMES=@FileOwner\nPUBLIC_URL=https://file.example\nPORT=3101\nDATA_DIR=private-data\n`, { mode: 0o600 });
    const fromFile = await execute(process.execPath, ['--env-file-if-exists=.env', '--import', loader, '--input-type=module', '-e', probe], { cwd, env: processEnv });
    assert.deepEqual(JSON.parse(fromFile.stdout), { owners: ['fileowner'], port: 3101, publicUrl: 'https://file.example', dataDir: join(cwd, 'private-data') });
    const overridden = await execute(process.execPath, ['--env-file-if-exists=.env', '--import', loader, '--input-type=module', '-e', probe], { cwd, env: { ...processEnv, TELEGRAM_OWNER_USERNAMES: '@ExportedOwner', PORT: '4102', PUBLIC_URL: 'https://exported.example' } });
    const actual = JSON.parse(overridden.stdout);
    assert.deepEqual(actual.owners, ['exportedowner']);
    assert.equal(actual.port, 4102);
    assert.equal(actual.publicUrl, 'https://exported.example');
    const help = await execute(process.execPath, ['--env-file-if-exists=.env', cli, '--help'], { cwd, env: processEnv });
    assert.ok(help.stdout.includes('TELEGRAM_OWNER_USERNAMES'));
    await writeFile(envFile, `TELEGRAM_BOT_TOKEN=${fixtureToken}\n`);
    await assert.rejects(execute(process.execPath, ['--env-file-if-exists=.env', cli, 'start'], { cwd, env: processEnv }), error => {
      const failure = error as Error & { code?: number; stderr?: string; stdout?: string };
      assert.equal(failure.code, 1);
      assert.ok(failure.stderr?.includes('TELEGRAM_OWNER_USERNAMES'));
      assert.ok(failure.stderr?.includes('PUBLIC_URL'));
      assert.equal((failure.stderr ?? '').includes(fixtureToken), false);
      return true;
    });
    for (const args of [['start', '--config', 'unused.json'], ['init']]) {
      await assert.rejects(execute(process.execPath, [cli, ...args], { cwd, env: processEnv }), error => {
        const failure = error as Error & { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.ok(failure.stderr?.includes('Usage:'));
        return true;
      });
    }
    console.log('PASS actual Node .env loading, exported-value precedence, username normalization, compiled CLI diagnostics, and removed JSON/init paths.');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyEnvironmentCli();
