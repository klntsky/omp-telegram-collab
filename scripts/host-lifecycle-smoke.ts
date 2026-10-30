import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from '@lydell/node-pty';

export async function verifyBusyHostRetirement(directory: string, executable: string, relayUrl: string): Promise<void> {
  const started = join(directory,'hold-started');
  const release = join(directory,'hold-release');
  const finished = join(directory,'hold-finished');
  const extension = join(directory,'hold-extension.mjs');
  const history = join(directory,'guard-history.jsonl');
  const overlay = join(directory,'guard-runtime.json');
  await writeFile(history,JSON.stringify({type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd:directory})+'\n');
  await writeFile(overlay,JSON.stringify({collab:{autoStart:'control',relayUrl},startup:{checkUpdate:false,setupWizard:false}}));
  await writeFile(extension,`import {existsSync,writeFileSync} from 'node:fs';
export default pi=>pi.registerCommand('lifecycle-hold',{description:'Hold a local command without a model request',handler:async()=>{
  writeFileSync(${JSON.stringify(started)},'holding');
  while(!existsSync(${JSON.stringify(release)})){const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,20);await promise;}
  writeFileSync(${JSON.stringify(finished)},'finished');
}});`);
  const terminal = pty.spawn(executable,[
    '--cwd',directory,'--session-dir',directory,'--resume',history,
    '--config',overlay,'--no-extensions','--no-skills','--no-rules','--no-context-files','--no-title',
    '--extension',extension,'--extension',fileURLToPath(new URL('../src/host-lifecycle.mjs',import.meta.url)),
  ],{cwd:directory,env:{...process.env,TERM:'xterm-256color',OMP_TELEGRAM_SESSION_DIR:directory,OMP_TELEGRAM_DEFAULT_PRESET:''},name:'xterm-256color',cols:100,rows:30});
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
  let lifecycle: {socketPath:string;sessionId:string;pid:number;retirement:number} | undefined;
  async function requestRetirement(): Promise<void> {
    assert.ok(lifecycle);
    assert.equal(lifecycle.retirement,1);
    const requestId = randomUUID();
    const grant = join(directory,`retirement-${requestId}.request`);
    await writeFile(grant,'',{flag:'wx',mode:0o600});
    const request = {type:'retire',requestId,sessionId:lifecycle.sessionId,pid:lifecycle.pid,deadline:Date.now()+2000,guard:'none'};
    const {promise,resolve,reject} = Promise.withResolvers<void>();
    const socket = createConnection(lifecycle.socketPath);
    socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Retirement request timed out'));});
    socket.once('error',reject);
    socket.once('end',()=>reject(new Error('Retirement host disconnected before acknowledgement')));
    socket.once('close',()=>reject(new Error('Retirement host closed before acknowledgement')));
    socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    let input = '';
    socket.on('data',data=>{
      input += data.toString();
      if (!input.includes('\n')) return;
      socket.destroy();
      try {
        const response = JSON.parse(input.trim());
        assert.equal(response.requestId,requestId);
        assert.equal(response.sessionId,request.sessionId);
        assert.equal(response.pid,request.pid);
        assert.equal(response.outcome,'requested');
        resolve();
      } catch (error) { reject(error); }
    });
    try { await promise; }
    finally { await rm(grant,{force:true}); }
  }
  try {
    await waitFor(()=>exists(join(directory,'lifecycle.json')),'Lifecycle extension did not start');
    lifecycle = JSON.parse(await readFile(join(directory,'lifecycle.json'),'utf8'));
    terminal.write('/lifecycle-hold\r');
    await waitFor(()=>exists(started),'Local command did not start');
    await requestRetirement();
    await delay(2000);
    assert.equal(exited,false,'retirement must not terminate an admitted, working command');
    assert.equal(await exists(finished),false,'the guarded command must remain in progress until explicitly released');
    await writeFile(release,'release');
    await waitFor(()=>exists(finished),'Retirement interrupted the working command');
    await waitFor(()=>exited,'Idle host did not retire after its admitted command completed');
    console.log('PASS actual OMP host defers retirement while a local command is working, lets it finish, then exits without a signal.');
  } finally {
    await writeFile(release,'release');
    if (!exited && lifecycle) {
      await requestRetirement().catch(()=>{});
      await waitFor(()=>exited,'Guard smoke host failed to retire');
    }
  }
}
