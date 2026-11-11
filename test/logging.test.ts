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
  assert.match(record.error.diagnostic, /Original boundary failure/);
  assert.match(record.error.diagnostic, /Diagnostic line two/);
  assert.match(record.error.diagnostic, /\[code\]: 23/);
  assert.match(record.error.diagnostic, /\[signal\]: 'SIGTERM'/);
  assert.match(record.error.diagnostic, /\[killed\]: true/);
});
