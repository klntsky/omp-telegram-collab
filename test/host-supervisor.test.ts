import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);

test('supervisor bounds private terminal output and retains final diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-terminal-log-'));
  try {
    const script = "process.stdout.write('x'.repeat(3 * 1024 * 1024), () => { process.stderr.write('Original diagnostic\\nsecond line\\n'); });";
    await execute(process.execPath, [resolve('src/host-supervisor.mjs'), process.execPath, '-e', script], {
      env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: directory }, timeout: 20000,
    });
    for (const name of ['terminal.log', 'terminal.log.1']) {
      const info = await stat(join(directory, name));
      assert.ok(info.size <= 1024 * 1024);
      assert.equal(info.mode & 0o777, 0o600);
    }
    const current = await readFile(join(directory, 'terminal.log'), 'utf8');
    assert.match(current, /Original diagnostic\r?\nsecond line/);
    assert.match(current, /OMP exited: code=0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('supervisor records the original executable startup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-terminal-error-'));
  try {
    await assert.rejects(execute(process.execPath, [resolve('src/host-supervisor.mjs'), join(directory, 'missing-omp')], {
      env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: directory }, timeout: 10000,
    }));
    assert.match(await readFile(join(directory, 'terminal.log'), 'utf8'), /No such file or directory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
