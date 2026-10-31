import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

test('passive resolution adopts existing identities and never launches absent or disappearing hosts', {timeout:15000}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(),'omp-existing-host-')));
  const statePath = join(directory,'registry.json');
  const commandsPath = join(directory,'commands.jsonl');
  const executable = join(directory,'omp');
  const history = join(directory,'history.jsonl');
  const config: AppConfig = {
    bots:[],instances:{[directory]:{chats:[]}},configPath:join(directory,'config.yaml'),
    publicUrl:'',host:'127.0.0.1',port:0,dataDir:directory,
    omp:{executable,args:[],maxSessions:1,startupTimeoutMs:5000},
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  const session: TopicSession = {id:'topic',botId:1,chatId:-100,threadId:42,instancePath:directory,
    name:'Existing host',status:'open',createdAt:0,runtime:{kind:'managed'}};
  const host = {instanceId:'existing-host',sessionId:'history-id',generation:7,pid:process.pid,
    cwd:directory,access:'control',relayConnected:true};
  const url = `wss://localhost/r/fixture-room.${Buffer.alloc(48,1).toString('base64url')}`;
  try {
    await writeFile(commandsPath,'');
    await writeFile(statePath,JSON.stringify({hosts:[]}));
    await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandsPath)},JSON.stringify(args)+'\\n');
if(args[0]!=='collab')throw new Error('Passive resolution attempted host startup');
const file=${JSON.stringify(statePath)};
const state=JSON.parse(fs.readFileSync(file,'utf8'));
if(args[1]==='list')console.log(JSON.stringify({version:1,hosts:state.hosts}));
else if(args[1]==='link'){
  if(state.fail){process.stderr.write('Capability lookup failed\\nOriginal diagnostic line two\\n');process.exit(23);}
  const host=state.hosts[0];
  if(state.disappear)fs.writeFileSync(file,JSON.stringify({hosts:[]}));
  console.log(JSON.stringify({version:1,instanceId:host.instanceId,generation:host.generation,access:'control',url:${JSON.stringify(url)}}));
}else throw new Error('Unexpected registry command');
`);
    await chmod(executable,0o700);
    assert.equal(await runtime.resolveExisting(session),undefined);
    assert.equal(await readFile(commandsPath,'utf8'),'');
    const metadata = join(directory,'sessions',session.id,'binding.json');
    await mkdir(join(directory,'sessions',session.id),{recursive:true});
    await writeFile(history,JSON.stringify({type:'session',version:3,id:host.sessionId,cwd:directory})+'\n');
    await writeFile(metadata,JSON.stringify({version:1,sessionId:host.sessionId,sessionFile:history,cwd:directory}));
    assert.equal(await runtime.resolveExisting(session),undefined);
    await writeFile(statePath,JSON.stringify({hosts:[host]}));
    assert.deepEqual(await runtime.resolveExisting(session),{
      instanceId:host.instanceId,sessionId:host.sessionId,generation:host.generation,url,
    });
    const attached: TopicSession = {...session,id:'attached-topic',runtime:{kind:'attached',instanceId:host.instanceId,sessionId:host.sessionId}};
    assert.deepEqual(await runtime.resolveExisting(attached),{
      instanceId:host.instanceId,sessionId:host.sessionId,generation:host.generation,url,
    });
    await writeFile(statePath,JSON.stringify({hosts:[host],fail:true}));
    const failedLookup = Promise.withResolvers<Error & {code?: unknown}>();
    execFile(executable,['collab','link',host.instanceId,'--json'],{cwd:directory,timeout:5000},error => {
      if (error) failedLookup.resolve(error);
      else failedLookup.reject(new Error('Expected capability lookup failure'));
    });
    const original = await failedLookup.promise;
    await assert.rejects(runtime.resolveExisting(session),error => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code,original.code);
      assert.equal(error.message,original.message);
      return true;
    });
    await writeFile(statePath,JSON.stringify({hosts:[host],disappear:true}));
    await assert.rejects(runtime.resolveExisting(session),/OMP host session changed while resolving its capability/);
    assert.equal(await runtime.resolveExisting(session),undefined);
    const commands = (await readFile(commandsPath,'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.deepEqual([...new Set(commands.map(args => args.slice(0,2).join(' ')))].sort(),['collab link','collab list']);
    await assert.rejects(stat(join(directory,'runtime-lock.sqlite')),{code:'ENOENT'});
    await writeFile(join(directory,'sessions',session.id,'lifecycle.json'),JSON.stringify({
      pid:host.pid,sessionId:host.sessionId,socketPath:join(directory,'lifecycle.sock'),
    }));
    await assert.rejects(runtime.stop(session.id),/does not support safe retirement/);
  } finally { await runtime.close(); await rm(directory,{recursive:true,force:true}); }
});
