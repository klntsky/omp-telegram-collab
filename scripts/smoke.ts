import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const stages = {
  cli: './env-smoke.ts',
  telegram: './telegram-smoke.ts',
  gateway: './gateway-smoke.ts',
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
  console.log(`START smoke ${name}`);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(stages[name], import.meta.url))], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
    const result = await promise;
    results.push({ name, ...result });
  } catch (error) {
    console.error(`FAIL smoke ${name}`);
    console.error(error);
    results.push({ name, code: null, signal: null });
  }
}

console.log('\nSmoke results:');
for (const [index, result] of results.entries()) {
  const passed = result.code === 0;
  console.log(`${index + 1}. ${result.name}: ${passed ? 'PASS' : `FAIL (exit ${result.code}, signal ${result.signal})`}`);
  if (!passed) process.exitCode = 1;
}
