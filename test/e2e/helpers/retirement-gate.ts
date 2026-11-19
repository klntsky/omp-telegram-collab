import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeConfig } from '../../../src/config.js';
import type { CollaborationTest } from './collaboration-fixture.js';
import { activeLaunchDir } from '../../../src/runtime/launch-record.js';

export async function installRetirementGate(app: CollaborationTest) {
  const extension = join(app.omp.dataDir, 'retirement-gate.mjs');
  const armed = join(app.omp.dataDir, 'retirement-gate.armed');
  const entered = join(app.omp.dataDir, 'retirement-gate.entered');
  await writeFile(extension, `import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('session_shutdown', () => {
    if (!existsSync(${JSON.stringify(armed)}) || readFileSync(${JSON.stringify(armed)}, 'utf8') !== process.env.OMP_TELEGRAM_SESSION_DIR) return;
    unlinkSync(${JSON.stringify(armed)});
    writeFileSync(${JSON.stringify(entered)}, String(process.pid));
    // A process pause outlives OMP's two-second shutdown-handler timeout.
    // https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/extensibility/extensions/runner.ts#L174-L184
    process.kill(process.pid, 'SIGSTOP');
  });
}
`);
  app.config.omp.args.push('--extension', extension);
  writeConfig(app.config);
  let released = false;
  return {
    arm: async (sessionId: string) => writeFile(armed, await activeLaunchDir(join(app.omp.dataDir, 'sessions', sessionId))),
    entered: () => existsSync(entered),
    release() {
      if (!released && existsSync(entered)) {
        process.kill(Number(readFileSync(entered, 'utf8')), 'SIGCONT');
        released = true;
      }
    },
  };
}
