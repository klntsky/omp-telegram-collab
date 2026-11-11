import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AppConfig } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';
import { watch } from 'node:fs';

async function fixture(t: TestContext, failure = false, held = false) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-skill-discovery-'));
  const executable = join(directory, 'omp');
  const counter = join(directory, 'calls');
  const catalog = join(directory, 'catalog.json');
  const gate = join(directory, 'release');
  const pidFile = join(directory, 'pid');
  const ready = Promise.withResolvers<number>();
  const watcher = watch(directory, async (_event, filename) => {
    if (filename !== 'pid') return;
    try {
      const pid = Number(await readFile(pidFile,'utf8'));
      if (pid > 0) ready.resolve(pid);
    } catch (error) { ready.reject(error); }
  });
  t.after(() => watcher.close());
  await writeFile(catalog, JSON.stringify([{name:'skill:Acme/pdf-tools',description:'Read PDFs',source:'skill'}]));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, 'call\\n');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(join(directory, 'cwd'))}, process.cwd());
${failure ? "process.stderr.write('Original catalog diagnostic\\nPermission denied: <skills> & config\\n'); process.exit(23);" : `let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => {
  input += part;
  if (!input.includes('\\n')) return;
  const request = JSON.parse(input.trim());
  const respond = () => {
    ${held ? `if (!fs.existsSync(${JSON.stringify(gate)})) {
      const watcher = fs.watch(${JSON.stringify(directory)}, (_event, filename) => {
        if (filename === 'release') { watcher.close(); respond(); }
      });
      return;
    }` : ''}
    process.stdout.write(JSON.stringify({type:'response', id:request.id, command:'get_available_commands', success:true, data:{commands:JSON.parse(fs.readFileSync(${JSON.stringify(catalog)}, 'utf8'))}}) + '\\n');
  };
  respond();
});`}
`);
  await chmod(executable, 0o700);
  const config: AppConfig = {
    bots: [], instances: [{id: 1, defaultDir: directory, chats: []}], configPath:join(directory,'config.yaml'),
    publicUrl:'https://localhost:3000',host:'127.0.0.1',port:3000,dataDir:directory,
    omp:{executable,args:[],maxSessions:1,startupTimeoutMs:10000},
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  t.after(async () => { await runtime.close(); await rm(directory,{recursive:true,force:true}); });
  return {runtime,directory,catalog,gate,ready:ready.promise,calls:async () => (await readFile(counter,'utf8')).trim().split('\n').length};
}

test('stopped worktree sessions discover skills in their own cwd and cache separately from the assigned project', async t => {
  const app = await fixture(t);
  const worktree = join(app.directory, 'worktree');
  await mkdir(worktree);
  t.mock.method(app.runtime, 'isRunning', async () => false);
  const session = {
    id: 'worktree-skills', botId: 1, chatId: -100, threadId: 2, instanceId: 1,
    name: 'Worktree skills', status: 'open' as const, createdAt: Date.now(),
    cwd: worktree, runtime: { kind: 'managed' as const },
  };
  await app.runtime.listSkills(1, session);
  assert.equal(await readFile(join(app.directory, 'cwd'), 'utf8'), worktree);
  await app.runtime.listSkills(1);
  assert.equal(await readFile(join(app.directory, 'cwd'), 'utf8'), app.directory);
  assert.equal(await app.calls(), 2);
  await app.runtime.listSkills(1, session);
  assert.equal(await app.calls(), 2);
  await assert.rejects(app.runtime.listSkills(2, session), /Instance ID is not configured/);
});

test('new folder skill discovery keeps configured assignment separate from execution context', async t => {
  const app = await fixture(t);
  const selected = join(app.directory,'selected');
  await mkdir(selected);
  const catalog = await app.runtime.listSkills(1, undefined,undefined,selected);
  assert.deepEqual(catalog,[{name:'Acme/pdf-tools',description:'Read PDFs'}]);
  assert.equal(await readFile(join(app.directory,'cwd'),'utf8'),selected);
  await assert.rejects(app.runtime.listSkills(2), /Instance ID is not configured/);
  await app.runtime.listSkills(1);
  assert.equal(await readFile(join(app.directory,'cwd'),'utf8'),app.directory);
});

test('discovery failures preserve multiline diagnostics and share a bounded failure cooldown', async t => {
  const app = await fixture(t,true);
  let now = Date.now();
  t.mock.method(Date,'now',() => now);
  let first: unknown;
  await assert.rejects(app.runtime.listSkills(1), error => {
    first = error;
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('Original catalog diagnostic\nPermission denied: <skills> & config\n'));
    return true;
  });
  await assert.rejects(app.runtime.listSkills(1),error => error === first);
  assert.equal(await app.calls(),1);
  now += 30001;
  await assert.rejects(app.runtime.listSkills(1),error => error !== first && error instanceof Error && error.message.includes('Original catalog diagnostic'));
  assert.equal(await app.calls(),2);
});

test('canceling the last catalog consumer kills discovery without poisoning the next request', {timeout:5000}, async t => {
  const app = await fixture(t,false,true);
  const controller = new AbortController();
  const reason = new Error('Catalog owner stopped');
  const pending = app.runtime.listSkills(1, undefined,controller.signal);
  const pid = await app.ready;
  controller.abort(reason);
  await assert.rejects(pending,error => error === reason);
  assert.throws(() => process.kill(pid,0),{code:'ESRCH'});
  await writeFile(app.gate,'release');
  assert.deepEqual(await app.runtime.listSkills(1),[{name:'Acme/pdf-tools',description:'Read PDFs'}]);
});

test('canceling one catalog consumer preserves discovery for another consumer', {timeout:5000}, async t => {
  const app = await fixture(t,false,true);
  const controller = new AbortController();
  const first = app.runtime.listSkills(1, undefined,controller.signal);
  const second = app.runtime.listSkills(1);
  await app.ready;
  const reason = new Error('One menu stopped');
  controller.abort(reason);
  await assert.rejects(first,error => error === reason);
  await writeFile(app.gate,'release');
  assert.deepEqual(await second,[{name:'Acme/pdf-tools',description:'Read PDFs'}]);
});
