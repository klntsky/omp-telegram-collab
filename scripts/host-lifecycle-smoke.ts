import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from '@lydell/node-pty';
import { procIdentity } from '../src/runtime/process.js';
import { requestLifecycle } from '../src/runtime/lifecycle-client.js';
import type { HostLifecycle } from '../src/runtime/types.js';

export async function verifyBusyHostRetirement(directory: string, executable: string, relayUrl: string): Promise<void> {
  const started = join(directory,'hold-started');
  const release = join(directory,'hold-release');
  const finished = join(directory,'hold-finished');
  const extension = join(directory,'hold-extension.mjs');
  const history = join(directory,'guard-history.jsonl');
  const overlay = join(directory,'guard-runtime.json');
  const slotId = 'guard';
  const launchId = randomUUID();
  const launchDirectory = join(directory, 'sessions', slotId, 'launches', launchId);
  await mkdir(launchDirectory, { recursive: true, mode: 0o700 });
  await writeFile(history,JSON.stringify({type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd:directory})+'\n');
  await writeFile(overlay,JSON.stringify({collab:{autoStart:'control',relayUrl},startup:{checkUpdate:false,setupWizard:false}}));
  await writeFile(extension,`import {existsSync,writeFileSync} from 'node:fs';
export default pi=>pi.registerCommand('lifecycle-hold',{description:'Hold a local command without a model request',handler:async()=>{
  writeFileSync(${JSON.stringify(started)},'holding');
  while(!existsSync(${JSON.stringify(release)})){const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,20);await promise;}
  writeFileSync(${JSON.stringify(finished)},'finished');
}});`);
  const terminal = pty.spawn(executable,[
    '--cwd',directory,'--session-dir',launchDirectory,'--resume',history,
    '--config',overlay,'--no-extensions','--no-skills','--no-rules','--no-context-files','--no-title',
    '--extension',extension,'--extension',fileURLToPath(new URL('../src/host-lifecycle.mjs',import.meta.url)),
  ],{cwd:directory,env:{...process.env,TERM:'xterm-256color',OMP_TELEGRAM_SESSION_DIR:launchDirectory,OMP_TELEGRAM_LAUNCH_ID:launchId,OMP_TELEGRAM_SUPERVISOR_PID:String(process.pid),OMP_TELEGRAM_DEFAULT_PRESET:''},name:'xterm-256color',cols:100,rows:30});
  let exited = false;
  let output = '';
  terminal.onData(part => { output = (output+part).slice(-4000); });
  terminal.onExit(() => { exited = true; });
  async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
    const deadline = Date.now()+20000;
    while (!await predicate()) {
      if (Date.now() >= deadline) throw new Error(`${label}: ${output}`);
      await delay(25);
    }
  }
  async function exists(filename: string): Promise<boolean> {
    try { await readFile(filename); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  let lifecycle: HostLifecycle | undefined;
  async function requestRetirement(): Promise<void> {
    assert.ok(lifecycle);
    assert.equal(lifecycle.retirement, 2);
    const identity = await procIdentity(lifecycle.pid);
    assert.ok(identity);
    const requestId = randomUUID();
    const provenance = {
      requestId, slotId, launchId, requesterPid: process.pid,
      targetPid: lifecycle.pid, targetStart: identity.start,
      requestedAt: new Date().toISOString(), reason: 'stop' as const,
    };
    const grant = join(launchDirectory, `retirement-${requestId}.request`);
    await writeFile(grant, JSON.stringify(provenance), { flag: 'wx', mode: 0o600 });
    try {
      const response = await requestLifecycle(lifecycle, {
        type: 'retire', requestId, sessionId: lifecycle.sessionId, pid: lifecycle.pid,
        deadline: Date.now() + 2000, guard: 'none', provenance,
      });
      if (typeof response.error === 'string') throw new Error(response.error);
      assert.equal(response.outcome, 'requested');
    } finally { await rm(grant, { force: true }); }
  }
  try {
    await waitFor(() => exists(join(launchDirectory, 'lifecycle.json')), 'Lifecycle extension did not start');
    lifecycle = JSON.parse(await readFile(join(launchDirectory, 'lifecycle.json'), 'utf8'));
    terminal.write('/lifecycle-hold\r');
    await waitFor(()=>exists(started),'Local command did not start');
    await requestRetirement();
    await delay(2000);
    assert.equal(exited,false,'retirement must not terminate an admitted, working command');
    assert.equal(await exists(finished),false,'the guarded command must remain in progress until explicitly released');
    await writeFile(release,'release');
    await waitFor(()=>exists(finished),'Retirement interrupted the working command');
    await waitFor(()=>exited,'Idle host did not retire after its admitted command completed');
    const accepted = JSON.parse(await readFile(join(launchDirectory, 'retirement-accepted.json'), 'utf8'));
    assert.equal(accepted.targetPid, lifecycle!.pid);
    assert.equal(accepted.reason, 'stop');
    console.log('PASS actual OMP host defers retirement while a local command is working, lets it finish, then exits without a signal.');
  } finally {
    await writeFile(release,'release');
    if (!exited && lifecycle) {
      await requestRetirement().catch(error => { console.error('Native retirement smoke cleanup failed:', error); terminal.kill('SIGKILL'); });
      await waitFor(()=>exited,'Guard smoke host failed to retire');
    }
  }
}
