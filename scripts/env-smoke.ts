import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureToken = '123456789:fixture-token-not-valid-on-telegram';

export async function verifyEnvironmentCli(): Promise<void> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'omp-config-cli-')));
  const processEnv = { PATH: process.env.PATH ?? '', HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'xdg') };
  const configPath = join(cwd, 'custom.yaml');
  const cli = join(root, 'dist', 'cli.js');
  const run = (...args: string[]) => execute(process.execPath, [cli, ...args], { cwd, env: processEnv });
  try {
    const configured = await run('--config', configPath, 'configure', '--public-url', 'https://cli.example', '--port', '3101', '--data-dir', 'private-data');
    assert.equal(configured.stdout.includes(fixtureToken), false);
    await run('--config', configPath, 'create', '.');
    const config = readConfig(configPath);
    assert.equal(config.configPath, configPath);
    assert.deepEqual(config.instances[cwd], {chats: []});
    assert.equal(config.port, 3101);
    assert.equal(config.publicUrl, 'https://cli.example');
    assert.equal(config.dataDir, join(cwd, 'private-data'));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const second = join(cwd, 'other checkout');
    await mkdir(second);
    const alias = join(cwd, 'checkout-alias');
    await symlink(second, alias);
    await run('--config', configPath, 'create', alias);
    assert.deepEqual(readConfig(configPath).instances[second], {chats: []});
    assert.equal(readConfig(configPath).instances[alias], undefined);
    const listed = await run('list', '--config', configPath);
    assert.ok(listed.stdout.includes(second));
    assert.equal(listed.stdout.includes(fixtureToken), false);
    const before = await readFile(configPath, 'utf8');
    await assert.rejects(run('--config', configPath, 'create', '.'));
    assert.equal(await readFile(configPath, 'utf8'), before, 'duplicate creation must never overwrite an existing instance');
    await assert.rejects(run('--config', configPath, 'configure', '--public-url', `https://${fixtureToken}@cli.example`), error => {
      const failure = error as Error & { stderr?: string };
      assert.ok(failure.stderr?.includes(configPath));
      assert.equal(failure.stderr?.includes(fixtureToken), false);
      return true;
    });
    assert.equal(await readFile(configPath, 'utf8'), before, 'invalid configuration must not replace existing YAML');
    await chmod(configPath, 0o400);
    await assert.rejects(run('--config', configPath, 'configure', '--max-sessions', '50'), error => {
      const failure = error as Error & { stderr?: string };
      assert.ok(failure.stderr?.includes(configPath));
      assert.equal(failure.stderr?.includes(fixtureToken), false);
      return true;
    });
    const shown = await run('--config', configPath, 'show', '.');
    assert.ok(shown.stdout.includes(cwd));
    assert.equal(shown.stdout.includes(fixtureToken), false);
    assert.equal(await readFile(configPath, 'utf8'), before);
    const missing = join(cwd, 'missing.yaml');
    await assert.rejects(run('start', '--config', missing), error => {
      const failure = error as Error & { stderr?: string };
      assert.ok(failure.stderr?.includes(missing));
      assert.equal(failure.stderr?.includes(fixtureToken), false);
      return true;
    });
    console.log('PASS compiled CLI YAML creation/configuration, alternate config path, canonical path identities, protected-file reads/write rejection, atomic refusal, and credential-safe errors.');
  } finally {
    await chmod(configPath, 0o600).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyEnvironmentCli();
