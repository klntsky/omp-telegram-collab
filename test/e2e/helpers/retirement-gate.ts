import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeConfig } from '../../../src/config.js';
import type { CollaborationTest } from './collaboration-fixture.js';

export async function installRetirementGate(app: CollaborationTest) {
  const extension = join(app.omp.dataDir, 'retirement-gate.mjs');
  const armed = join(app.omp.dataDir, 'retirement-gate.armed');
  const entered = join(app.omp.dataDir, 'retirement-gate.entered');
  await writeFile(extension, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
export default function (pi) {
  pi.on('session_shutdown', () => {
    if (!existsSync(${JSON.stringify(armed)}) || readFileSync(${JSON.stringify(armed)}, 'utf8') !== basename(process.env.OMP_TELEGRAM_SESSION_DIR ?? '')) return;
    writeFileSync(${JSON.stringify(entered)}, String(process.pid));
    // A process pause outlives OMP's two-second shutdown-handler timeout.
    // https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/extensibility/extensions/runner.ts#L174-L184
    process.kill(process.pid, 'SIGSTOP');
  });
}
`);
  app.config.omp.args.push('--extension', extension);
  writeConfig(app.config);
  return {
    arm: (sessionId: string) => writeFile(armed, sessionId),
    entered: () => existsSync(entered),
    release() {
      if (existsSync(entered)) process.kill(Number(readFileSync(entered, 'utf8')), 'SIGCONT');
    },
  };
}
