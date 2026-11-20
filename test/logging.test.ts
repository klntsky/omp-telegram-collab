import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

it('structured error records retain nested and non-enumerable failure diagnostics', () => {
  const source = `
    import { logEvent } from ${JSON.stringify(new URL('../src/logging.ts', import.meta.url).href)};
    const cause = new Error('Original boundary failure\\nDiagnostic line two');
    const error = new AggregateError([cause], 'Cleanup failure', { cause });
    Object.defineProperties(error, {
      code: { value: 23 },
      signal: { value: 'SIGTERM' },
      killed: { value: true },
    });
    logEvent('warn', 'boundary-failed', { sessionId: 'session', error });
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10000,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const record = JSON.parse(child.stderr);
  assert.equal(record.event, 'boundary-failed');
  assert.equal(record.sessionId, 'session');
  assert.equal(record.error.name, 'AggregateError');
  assert.equal(record.error.message, 'Cleanup failure');
  assert.equal(record.error.cause.message, 'Original boundary failure\nDiagnostic line two');
  assert.equal(record.error.code, 23);
  assert.equal(record.error.signal, 'SIGTERM');
  assert.equal(record.error.killed, true);
  assert.equal(record.error.errors[0].message, record.error.cause.message);
});

it('transport diagnostics omit the credential-bearing fetch error instead of rewriting it', () => {
  const source = `
    import { Api } from 'grammy';
    import { logEvent } from ${JSON.stringify(new URL('../src/logging.ts', import.meta.url).href)};
    const token = '123456789:' + 'synthetic_transport_credential_'.repeat(2);
    const api = new Api(token, { apiRoot: 'http://127.0.0.1:1' });
    try {
      await api.getChat(1);
      throw new Error('Unexpected transport success');
    } catch (error) {
      logEvent('error', 'telegram-operation-failed', { error });
    }
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10000,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const record = JSON.parse(child.stderr);
  assert.equal(record.error.name, 'HttpError');
  assert.equal(record.error.transport.code, 'ECONNREFUSED');
  assert.equal(record.error.message, "Network request for 'getChat' failed!");
  assert.equal(record.error.error, undefined);
  assert.ok(!child.stderr.includes('synthetic_transport_credential_'));
  assert.ok(!child.stderr.includes('127.0.0.1'));
});

it('subprocess failure logs preserve exit status without command arguments or output', () => {
  const source = `
    import { execFile } from 'node:child_process';
    import { logEvent } from ${JSON.stringify(new URL('../src/logging.ts', import.meta.url).href)};
    execFile(process.execPath, ['-e', 'process.exit(23)', 'synthetic_subprocess_secret'], error => {
      if (!error) throw new Error('Unexpected subprocess success');
      logEvent('error', 'subprocess-failed', { error });
    });
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10000,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const record = JSON.parse(child.stderr);
  assert.equal(record.error.code, 23);
  assert.equal(record.error.killed, false);
  assert.equal(record.error.cmd, undefined);
  assert.equal(record.error.message, undefined);
  assert.equal(record.error.stack, undefined);
  assert.ok(!child.stderr.includes('synthetic_subprocess_secret'));
});
