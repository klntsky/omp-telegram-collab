import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const extension = pathToFileURL(resolve('src/host-lifecycle.mjs')).href;
for (const start of [false,true]) {
  test(`${start ? 'subagent' : 'unstarted extension'} shutdown preserves the main host lifecycle descriptor`, async () => {
    const directory = await mkdtemp(join(tmpdir(),'omp-lifecycle-owner-'));
    const descriptor = JSON.stringify({pid:12345,sessionId:'main-host',socketPath:'/tmp/main-host.sock',skills:true});
    try {
      await writeFile(join(directory,'lifecycle.json'),descriptor,{mode:0o600});
      await execute(process.execPath,['--input-type=module','-e',`
        import lifecycle from ${JSON.stringify(extension)};
        const handlers = new Map();
        await lifecycle({on:(name,handler)=>handlers.set(name,handler)});
        ${start ? "await handlers.get('session_start')({}, {agent:{kind:'task'}});" : ''}
        handlers.get('session_shutdown')();
      `],{env:{...process.env,OMP_TELEGRAM_SESSION_DIR:directory,OMP_TELEGRAM_DEFAULT_PRESET:''},timeout:10000});
      assert.equal(await readFile(join(directory,'lifecycle.json'),'utf8'),descriptor);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
}

test('the main host still removes its own lifecycle descriptor and socket on shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(),'omp-lifecycle-main-'));
  try {
    const result = await execute(process.execPath,['--input-type=module','-e',`
      import lifecycle from ${JSON.stringify(extension)};
      import {watch,existsSync,readFileSync} from 'node:fs';
      import {join} from 'node:path';
      const directory = process.env.OMP_TELEGRAM_SESSION_DIR;
      const filename = join(directory,'lifecycle.json');
      const handlers = new Map();
      await lifecycle({on:(name,handler)=>handlers.set(name,handler)});
      const ready = Promise.withResolvers();
      const watcher = watch(directory,()=>{
        if (!existsSync(filename)) return;
        watcher.close();
        ready.resolve();
      });
      await handlers.get('session_start')({}, {agent:{kind:'main'},cwd:directory,sessionManager:{getSessionId:()=> 'main-host'}});
      await ready.promise;
      const descriptor = JSON.parse(readFileSync(filename,'utf8'));
      handlers.get('session_shutdown')();
      console.log(JSON.stringify({descriptorExists:existsSync(filename),socketExists:existsSync(descriptor.socketPath)}));
    `],{env:{...process.env,OMP_TELEGRAM_SESSION_DIR:directory,OMP_TELEGRAM_DEFAULT_PRESET:''},timeout:10000});
    assert.deepEqual(JSON.parse(result.stdout),{descriptorExists:false,socketExists:false});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('title control invokes the persistent native API and preserves rename diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-lifecycle-title-'));
  try {
    const result = await execute(process.execPath, ['--input-type=module', '-e', `
      import lifecycle from ${JSON.stringify(extension)};
      import {watch,existsSync,readFileSync} from 'node:fs';
      import {createConnection} from 'node:net';
      import {join} from 'node:path';
      const directory = process.env.OMP_TELEGRAM_SESSION_DIR;
      const filename = join(directory, 'lifecycle.json');
      const handlers = new Map();
      const titles = [];
      await lifecycle({
        on:(name,handler)=>handlers.set(name,handler),
        async setSessionName(name) {
          if (name === 'fail') throw new Error('Native rename 🚫 failed\\nOriginal persistence diagnostic');
          titles.push(name);
        },
      });
      const ready = Promise.withResolvers();
      const watcher = watch(directory,()=>{
        if (!existsSync(filename)) return;
        watcher.close();
        ready.resolve();
      });
      await handlers.get('session_start')({}, {agent:{kind:'main'},cwd:directory,sessionManager:{getSessionId:()=> 'main-host'}});
      await ready.promise;
      const descriptor = JSON.parse(readFileSync(filename,'utf8'));
      async function rename(name, sessionId = 'main-host') {
        const {promise,resolve,reject} = Promise.withResolvers();
        const socket = createConnection(descriptor.socketPath);
        let input = '';
        socket.setEncoding('utf8');
        socket.on('error',reject);
        socket.on('data',part=>input+=part);
        socket.on('end',()=>resolve(JSON.parse(input)));
        socket.on('connect',()=>socket.write(JSON.stringify({
          type:'set_session_title',name,sessionId,requestId:'title',deadline:Date.now()+10000,
        })+'\\n'));
        return promise;
      }
      const applied = await rename('Telegram → OMP');
      const failed = await rename('fail');
      const stale = await rename('stale', 'other-session');
      handlers.get('session_shutdown')();
      console.log(JSON.stringify({supported:descriptor.sessionTitles,titles,applied,failed,stale}));
    `], { env: { ...process.env, OMP_TELEGRAM_SESSION_DIR: directory, OMP_TELEGRAM_DEFAULT_PRESET: '' }, timeout: 10000 });
    const output = JSON.parse(result.stdout);
    assert.equal(output.supported, true);
    assert.deepEqual(output.titles, ['Telegram → OMP']);
    assert.equal(output.applied.text, '');
    assert.equal(output.failed.error, 'Native rename 🚫 failed\nOriginal persistence diagnostic');
    assert.match(output.stale.error, /session identity changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
