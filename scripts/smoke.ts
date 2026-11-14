import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logEvent } from '../src/logging.js';

const stages = {
  cli: './env-smoke.ts',
  runtime: './runtime-smoke.ts',
};
type Stage = keyof typeof stages;
const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(stages);
for (const name of selected) {
  if (!Object.hasOwn(stages, name)) throw new Error(`Unknown smoke stage ${JSON.stringify(name)}. Choose: ${Object.keys(stages).join(', ')}`);
}

const results: { name: string; code: number | null; signal: NodeJS.Signals | null }[] = [];
for (const name of selected as Stage[]) {
  logEvent('info', 'smoke-stage-started', { stage: name });
  try {
    const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(stages[name], import.meta.url))], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
    const result = await promise;
    results.push({ name, ...result });
  } catch (error) {
    logEvent('error', 'smoke-stage-failed', { stage: name, error });
    results.push({ name, code: null, signal: null });
  }
}

for (const result of results) {
  const passed = result.code === 0;
  logEvent(passed ? 'info' : 'error', 'smoke-stage-completed', { stage: result.name, passed, exitCode: result.code, signal: result.signal });
  if (!passed) process.exitCode = 1;
}
