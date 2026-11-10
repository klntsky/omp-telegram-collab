import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { runAdmin, type AdminDependencies } from '../src/cli-admin.js';
import { notifyReload } from '../src/cli/reload.js';
import { canonicalPath, ConfigError, emptyConfig, readConfig, writeConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const token = '123456789:fixture_token_never_live';
const secondToken = '987654321:second_fixture_token_never_live';


function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omp-cli-admin-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const configPath = join(root, 'selected.yaml');
  const project = join(root, 'project with spaces');
  const other = join(root, 'other project');
  mkdirSync(project);
  mkdirSync(other);
  const deps: AdminDependencies = {
    interactive: false,
    output: () => {},
  };
  const run = (args: string[], overrides: AdminDependencies = {}) => runAdmin(args, configPath, {...deps, ...overrides});
  const seed = () => {
    const config = emptyConfig(configPath);
    config.bots = [{id: 123456789, token, miniAppShortName: 'app'}];
    config.instances.push({id: 1, defaultDir: canonicalPath(project), chats: []});
    writeConfig(config);
    return config;
  };
  const store = () => new Store(join(readConfig(configPath).dataDir, 'telegram.sqlite'));
  return {root, configPath, project, other, run, seed, store};
}

test('create permits duplicate canonical directories and project selectors require numeric IDs', async t => {
  const f = fixture(t);
  const alias = join(f.root, 'alias');
  symlinkSync(f.project, alias);
  await f.run(['create', alias]);
  const path = canonicalPath(f.project);
  assert.deepEqual(readConfig(f.configPath).instances, [{id: 1, defaultDir: path, chats: []}]);
  await f.run(['create', f.project, '--id', '7']);
  assert.deepEqual(readConfig(f.configPath).instances.map(instance => instance.id), [1, 7]);
  await assert.rejects(f.run(['create', f.project, '--id', '7']), /already configured/);
  await assert.rejects(f.run(['create', f.other, '--admin', 'Alice']));
  await f.run(['list']);
  await assert.rejects(f.run(['show', alias]), /Instance ID/);
  await f.run(['show', '1']);
  await f.run(['show', '7']);
  await f.run(['remove', '1']);
  await f.run(['remove', '7']);
  assert.deepEqual(readConfig(f.configPath).instances, []);
});

test('Commander preserves literal OMP arguments and rejects unknown or excess arguments without writes', async t => {
  const f = fixture(t);
  await f.run(['setup', '--omp-arg=--model', '--omp-arg=--config', '--omp-arg', 'literal value with spaces']);
  assert.deepEqual(readConfig(f.configPath).omp.args, ['--model', '--config', 'literal value with spaces']);
  const original = readFileSync(f.configPath, 'utf8');
  await assert.rejects(f.run(['setup', '--omp-arg=--help']), ConfigError);
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  for (const args of [
    ['setup', '--port', '4200', '--unknown'],
    ['setup', '--port', '4200', 'extra'],
    ['create', f.project, f.other],
    ['bot', 'list', 'extra'],
    ['chat', 'unknown', f.project],
  ]) {
    await assert.rejects(f.run(args));
    assert.equal(readFileSync(f.configPath, 'utf8'), original);
  }
});


test('changing Mini App mode preserves registered names and fills only missing names', async t => {
  const f = fixture(t);
  await f.run(['setup', '--public-url', 'https://collab.example']);
  const config = readConfig(f.configPath);
  config.bots = [{id: 123456789, token, miniAppShortName: 'workspace'}];
  writeConfig(config);
  await f.run(['setup', '--public-url', '']);
  assert.equal(readConfig(f.configPath).publicUrl, '');
  assert.equal(readConfig(f.configPath).bots[0]!.miniAppShortName, 'workspace');
  const updated = readConfig(f.configPath);
  updated.bots.push({id: 987654321, token: secondToken});
  writeConfig(updated);
  assert.equal(readConfig(f.configPath).bots[1]!.miniAppShortName, undefined);
  await f.run(['setup', '--public-url', 'https://collab.example']);
  assert.equal(readConfig(f.configPath).bots[0]!.miniAppShortName, 'workspace');
  assert.equal(readConfig(f.configPath).bots[1]!.miniAppShortName, 'app');
});

test('interactive setup preserves the session limit while updating service settings', async t => {
  const f = fixture(t);
  await f.run(['setup', '--max-sessions', '37']);
  const dataDir = join(f.root, 'interactive data');
  const answers = ['no', dataDir, 'custom-omp', '["--model","selected model"]', '23456', 'wss://relay.example'];
  await f.run(['setup'], {
    interactive: true,
    question: async () => {
      const next = answers.shift();
      assert.notEqual(next, undefined);
      return next!;
    },
  });
  assert.deepEqual(answers, []);
  const config = readConfig(f.configPath);
  assert.equal(config.dataDir, dataDir);
  assert.deepEqual(config.omp, {
    executable: 'custom-omp',
    args: ['--model', 'selected model'],
    maxSessions: 37,
    startupTimeoutMs: 23456,
    relayUrl: 'wss://relay.example',
  });
});

test('interactive setup defaults to Telegram-only and preserves the current mode', async t => {
  const f = fixture(t);
  await f.run(['setup'], {interactive: true, question: async () => ''});
  assert.equal(readConfig(f.configPath).publicUrl, '');
  const config = readConfig(f.configPath);
  config.bots = [{id: 123456789, token}];
  writeConfig(config);
  await f.run(['setup'], {interactive: true, question: async prompt => {
    if (prompt.startsWith('Enable Mini App?')) return 'yes';
    if (prompt.startsWith('Public HTTPS origin')) return 'https://collab.example';
    return '';
  }});
  assert.equal(readConfig(f.configPath).publicUrl, 'https://collab.example');
  assert.equal(readConfig(f.configPath).bots[0]!.miniAppShortName, 'app');
  await f.run(['setup'], {interactive: true, question: async () => ''});
  assert.equal(readConfig(f.configPath).publicUrl, 'https://collab.example');
  await f.run(['setup'], {interactive: true, question: async prompt => prompt.startsWith('Enable Mini App?') ? 'no' : ''});
  assert.equal(readConfig(f.configPath).publicUrl, '');
  assert.equal(readConfig(f.configPath).bots[0]!.miniAppShortName, 'app');
});


test('chat add and approve reject invalid, missing and repeated prompt mode values without writes', async t => {
  const f = fixture(t);
  f.seed();
  const original = readFileSync(f.configPath, 'utf8');
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  for (const args of [
    ['chat', 'add', '1', '--chat', '-1001'],
    ['approve', pending.code, '--instance', '1', '--yes'],
  ]) {
    for (const flag of ['--all-messages-are-prompts', '--users-can-propose-prompts']) {
      for (const value of ['yes', 'no', 'TRUE', 'False', '1', '0', '', ' true', 'false ']) {
        await assert.rejects(f.run([...args, flag, value]), /must be true or false/);
      }
      await assert.rejects(f.run([...args, flag]));
      await assert.rejects(f.run([...args, flag, 'true', flag, 'false']), /only once/);
    }
  }
  await assert.rejects(f.run(['chat', 'remove', '1', '--chat', '-1001', '--users-can-propose-prompts', 'false']));
  await assert.rejects(f.run(['chat', 'list', '1', '--users-can-propose-prompts', 'false']));
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
});


test('configuration writes notify the old data directory and do not roll back failed reloads', async t => {
  const f = fixture(t);
  const initial = f.seed();
  const nextData = join(f.root, 'next-data');
  const seen: string[] = [];
  await assert.rejects(f.run(['setup', '--data-dir', nextData], {reload: async (config, previous) => { seen.push(previous); assert.equal(config.dataDir, nextData); throw new Error('Configuration saved, but service restart failed'); }}), /saved/);
  assert.deepEqual(seen, [initial.dataDir]);
  assert.equal(readConfig(f.configPath).dataDir, nextData);
});

test('reload notification requires an acknowledgement from the selected service socket', async t => {
  const f = fixture(t);
  const config = f.seed();
  mkdirSync(config.dataDir, {recursive: true});
  let received: unknown;
  let status = 200;
  // Exercise the real socket acknowledgement beyond the former five-second client deadline.
  let delay = 5100;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/reload');
    assert.equal(req.method, 'POST');
    let text = '';
    for await (const chunk of req) text += String(chunk);
    received = JSON.parse(text);
    await wait(delay);
    res.writeHead(status, {'content-type': 'application/json'});
    res.end(JSON.stringify(status === 200 ? {ok: true} : {error: 'wrong config'}));
  });
  server.listen(join(config.dataDir, 'control.sock'));
  await once(server, 'listening');
  try {
    await notifyReload(config);
    assert.deepEqual(received, {configPath: f.configPath});
    status = 409;
    delay = 0;
    await assert.rejects(notifyReload(config), /Configuration saved/);
  } finally { server.close(); await once(server, 'close'); }
});

