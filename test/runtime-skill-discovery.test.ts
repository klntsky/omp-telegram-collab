import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AppConfig } from '../shared/contracts.js';
import { writeConfig } from '../src/config.js';
import { OmpRuntime } from '../src/runtime.js';

async function fixture(t: TestContext, failure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-skill-discovery-'));
  const executable = join(directory, 'omp');
  const counter = join(directory, 'calls');
  const catalog = join(directory, 'catalog.json');
  await writeFile(catalog, JSON.stringify([{name:'skill:Acme/pdf-tools',description:'Read PDFs',source:'skill'}]));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, 'call\\n');
${failure ? "process.stderr.write('Original catalog diagnostic\\nPermission denied: <skills> & config\\n'); process.exit(23);" : `let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => {
  input += part;
  if (!input.includes('\\n')) return;
  const request = JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({type:'response', id:request.id, command:'get_available_commands', success:true, data:{commands:JSON.parse(fs.readFileSync(${JSON.stringify(catalog)}, 'utf8'))}}) + '\\n');
});`}
`);
  await chmod(executable, 0o700);
  const config: AppConfig = {
    bots: [], instances: {[directory]:{admins:[],chats:[]}}, configPath:join(directory,'config.yaml'),
    publicUrl:'https://localhost:3000',host:'127.0.0.1',port:3000,dataDir:directory,
    omp:{executable,args:[],maxSessions:1,startupTimeoutMs:10000},
  };
  writeConfig(config);
  const runtime = new OmpRuntime(config);
  t.after(async () => { await runtime.close(); await rm(directory,{recursive:true,force:true}); });
  return {runtime,directory,catalog,calls:async () => (await readFile(counter,'utf8')).trim().split('\n').length};
}

test('concurrent catalogs share discovery and new skills appear after freshness expires', async t => {
  const app = await fixture(t);
  let now = Date.now();
  t.mock.method(Date,'now',() => now);
  const results = await Promise.all([app.runtime.listSkills(app.directory),app.runtime.listSkills(app.directory),app.runtime.listSkills(app.directory)]);
  for (const result of results) assert.deepEqual(result,[{name:'Acme/pdf-tools',description:'Read PDFs'}]);
  assert.equal(await app.calls(),1);
  results[0]![0]!.name='mutated';
  await writeFile(app.catalog,JSON.stringify([{name:'skill:new-skill',description:'Newly installed',source:'skill'}]));
  assert.deepEqual(await app.runtime.listSkills(app.directory),[{name:'Acme/pdf-tools',description:'Read PDFs'}]);
  assert.equal(await app.calls(),1);
  now += 5 * 60000 + 1;
  assert.deepEqual(await app.runtime.listSkills(app.directory),[{name:'new-skill',description:'Newly installed'}]);
  assert.equal(await app.calls(),2);
});

test('discovery failures preserve multiline diagnostics and share a bounded failure cooldown', async t => {
  const app = await fixture(t,true);
  let now = Date.now();
  t.mock.method(Date,'now',() => now);
  let first: unknown;
  await assert.rejects(app.runtime.listSkills(app.directory), error => {
    first = error;
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('Original catalog diagnostic\nPermission denied: <skills> & config\n'));
    return true;
  });
  await assert.rejects(app.runtime.listSkills(app.directory),error => error === first);
  assert.equal(await app.calls(),1);
  now += 30001;
  await assert.rejects(app.runtime.listSkills(app.directory),error => error !== first && error instanceof Error && error.message.includes('Original catalog diagnostic'));
  assert.equal(await app.calls(),2);
});
