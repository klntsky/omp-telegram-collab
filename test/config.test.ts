import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { stringify } from 'yaml';
import type { AppConfig } from '../shared/contracts.js';
import { canonicalPath, ConfigError, configWritable, defaultConfigPath, emptyConfig, findInstance, readConfig, validateStart, writeConfig } from '../src/config.js';
import { botId, botToken, chatId } from './telegram-data.js';

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omp-config-test-')));
  t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'config.yaml');
  return { dir, path };
}

function validConfig(path: string, directory: string) {
  const config = emptyConfig(path);
  config.bots = [{ id: botId, token: botToken, miniAppShortName: 'app' }];
  config.instances[directory] = { admins: ['alice'], chats: [{ botId, chatId }] };
  config.publicUrl = 'https://collab.example.com';
  return config;
}

function assertInvalid(path: string, action: () => unknown, key?: string) {
  assert.throws(action, error => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.message.includes(path));
    if (key) assert.ok(error.keys.includes(key));
    return true;
  });
}

test('default config path honors XDG_CONFIG_HOME', () => {
  const before = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = '/tmp/custom-config-home';
    assert.equal(defaultConfigPath(), '/tmp/custom-config-home/omp-telegram/config.yaml');
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
});

test('draft YAML roundtrips without a serialized configPath and starts only once configured', t => {
  const { path, dir } = fixture(t);
  const config = emptyConfig(path);
  writeConfig(config);
  assert.deepEqual(readConfig(path), config);
  assert.equal(readFileSync(path, 'utf8').includes('configPath:'), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assertInvalid(path, () => validateStart(config), 'bots');
  const ready = validConfig(path, dir);
  writeConfig(ready);
  validateStart(readConfig(path));
});

test('missing config is never an implicit empty draft', t => {
  const { path } = fixture(t);
  assertInvalid(path, () => readConfig(path));
  assert.equal(existsSync(path), false);
});

test('YAML supports normalized per-path admins, multiple bots and multiple chats', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  config.bots.push({ id: 987654321, token: '987654321:second-fixture-token', miniAppShortName: 'other' });
  config.instances[dir]!.admins = ['@Alice', 'BOB_OWNER', 'alice'];
  config.instances[dir]!.chats.push(
    { botId: 987654321, chatId, all_messages_are_prompts: false, users_can_propose_prompts: true },
    { botId, chatId: -10042, all_messages_are_prompts: true, users_can_propose_prompts: true },
    { botId, chatId: -10043, all_messages_are_prompts: false, users_can_propose_prompts: false },
  );
  writeConfig(config);
  const loaded = readConfig(path);
  assert.deepEqual(loaded.instances[dir]!.admins, ['alice', 'bob_owner']);
  assert.equal(findInstance(loaded, 987654321, chatId)?.path, dir);
  assert.equal(findInstance(loaded, botId, -999), undefined);
  assert.deepEqual(loaded.instances[dir]!.chats, [
    { botId, chatId, all_messages_are_prompts: true, users_can_propose_prompts: false },
    { botId: 987654321, chatId, all_messages_are_prompts: false, users_can_propose_prompts: true },
    { botId, chatId: -10042, all_messages_are_prompts: true, users_can_propose_prompts: true },
    { botId, chatId: -10043, all_messages_are_prompts: false, users_can_propose_prompts: false },
  ]);
  writeConfig(loaded);
  assert.deepEqual(readConfig(path), loaded);
});

test('forum model defaults roundtrip independently for each bot/chat assignment and remain optional', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  config.bots.push({ id: 987654321, token: '987654321:second-fixture-token', miniAppShortName: 'other' });
  config.instances[dir]!.chats[0]!.default_model_preset = 'Fast';
  config.instances[dir]!.chats.push(
    { botId, chatId: -10042, default_model_preset: 'Slow' },
    { botId: 987654321, chatId, default_model_preset: 'Fast_2-beta' },
    { botId, chatId: -10043 },
  );
  writeConfig(config);
  const loaded = readConfig(path);
  assert.equal(findInstance(loaded, botId, chatId)?.instance.chats
    .find(chat => chat.botId === botId && chat.chatId === chatId)?.default_model_preset, 'Fast');
  assert.deepEqual(loaded.instances[dir]!.chats.map(({ botId, chatId, default_model_preset }) =>
    ({ botId, chatId, default_model_preset })), [
    { botId, chatId, default_model_preset: 'Fast' },
    { botId, chatId: -10042, default_model_preset: 'Slow' },
    { botId: 987654321, chatId, default_model_preset: 'Fast_2-beta' },
    { botId, chatId: -10043, default_model_preset: undefined },
  ]);
  assert.equal('default_model_preset' in loaded.instances[dir]!.chats[3]!, false);
  writeConfig(loaded);
  assert.deepEqual(readConfig(path), loaded);
});

test('forum model defaults reject names outside the native preset-name grammar', t => {
  const { path, dir } = fixture(t);
  const { configPath: _configPath, ...config } = validConfig(path, dir);
  for (const default_model_preset of ['', '1Fast', '../Fast', 'Fast/Slow', 'Fast Slow', 'Fast.Slow', true, 1, null, [], {}]) {
    writeFileSync(path, stringify({
      ...config,
      instances: { [dir]: { admins: ['alice'], chats: [{ botId, chatId, default_model_preset }] } },
    }));
    assertInvalid(path, () => readConfig(path), `instances.${dir}.chats.0.default_model_preset`);
  }
});

test('YAML defaults prompt options independently and rejects nonboolean values', t => {
  const { path, dir } = fixture(t);
  const { configPath: _configPath, ...config } = validConfig(path, dir);
  writeFileSync(path, stringify(config));
  assert.equal(readConfig(path).instances[dir]!.chats[0]!.all_messages_are_prompts, true);
  assert.equal(readConfig(path).instances[dir]!.chats[0]!.users_can_propose_prompts, false);
  for (const option of ['all_messages_are_prompts', 'users_can_propose_prompts']) {
    for (const mode of ['true', 'false', '', 0, 1, null, [], {}]) {
      writeFileSync(path, stringify({
        ...config,
        instances: { [dir]: { admins: ['alice'], chats: [{ botId, chatId, [option]: mode }] } },
      }));
      assertInvalid(path, () => readConfig(path), `instances.${dir}.chats.0.${option}`);
    }
  }
});

test('explicit creation canonicalizes directories but reads never retarget stored identity', t => {
  const { path, dir } = fixture(t);
  const original = join(dir, 'original');
  const other = join(dir, 'other');
  const alias = join(dir, 'alias');
  mkdirSync(original); mkdirSync(other); symlinkSync(original, alias);
  assert.equal(canonicalPath(alias), original);
  const config = validConfig(path, original);
  writeConfig(config);
  rmSync(original, { recursive: true });
  assert.equal(Object.keys(readConfig(path).instances)[0], original);
  config.instances[original]!.admins.push('bob');
  writeConfig(config);
  assert.deepEqual(readConfig(path).instances[original]!.admins, ['alice', 'bob']);
  symlinkSync(other, original);
  assert.equal(Object.keys(readConfig(path).instances)[0], original);
});

test('duplicate YAML path keys and normalized-path aliases are rejected', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  const { configPath: _configPath, ...value } = config;
  const source = stringify(value);
  writeFileSync(path, source.replace('instances:\n', `instances:\n  ${JSON.stringify(dir)}: {admins: [], chats: []}\n`));
  assertInvalid(path, () => readConfig(path));
  config.instances[`${dir}/../${dir.split('/').at(-1)}`] = { admins: [], chats: [] };
  assertInvalid(path, () => writeConfig(config));
});

test('new stored paths reject symlink aliases and missing directories rather than inventing identities', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  const alias = join(dir, 'alias');
  symlinkSync(dir, alias);
  config.instances[alias] = { admins: [], chats: [] };
  assertInvalid(path, () => writeConfig(config), 'instances');
  delete config.instances[alias];
  config.instances[join(dir, 'missing')] = { admins: [], chats: [] };
  assertInvalid(path, () => writeConfig(config), 'instances');
  assert.equal(existsSync(path), false);
});

test('duplicate bot IDs, tokens, chat assignments and missing referenced bots fail validation', t => {
  const { path, dir } = fixture(t);
  for (const change of [
    (config: AppConfig) => { config.bots.push({ ...config.bots[0]! }); },
    (config: AppConfig) => { config.bots.push({ ...config.bots[0]!, token: `${botId}:different-token` }); },
    (config: AppConfig) => { config.bots[0]!.id = 42; },
    (config: AppConfig) => { config.instances[join(dir, 'missing')] = { admins: [], chats: [{ botId, chatId }] }; },
    (config: AppConfig) => { config.instances[dir]!.chats.push({ botId: 42, chatId: -42 }); },
    (config: AppConfig) => { config.instances[dir]!.chats.push({ botId, chatId }); },
  ]) {
    const config = validConfig(path, dir);
    change(config);
    assertInvalid(path, () => writeConfig(config));
  }
});

test('YAML validates public origins, usernames, runtime fields and literal arguments without exposing secrets', t => {
  const { path, dir } = fixture(t);
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#fragment']) {
    const config = validConfig(path, dir); config.publicUrl = url;
    assertInvalid(path, () => writeConfig(config));
  }
  for (const username of ['', '123456', '@@alice', 'alice owner', 'a'.repeat(33)]) {
    const config = validConfig(path, dir); config.instances[dir]!.admins = [username];
    assertInvalid(path, () => writeConfig(config));
  }
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const config = validConfig(path, dir); config.omp.maxSessions = number;
    assertInvalid(path, () => writeConfig(config));
    config.omp.maxSessions = 8; config.omp.startupTimeoutMs = number;
    assertInvalid(path, () => writeConfig(config));
  }
  for (const arg of ['--cwd=/tmp', '--resume', '--from-branch=main', '\0']) {
    const config = validConfig(path, dir); config.omp.args = [arg];
    assertInvalid(path, () => writeConfig(config));
  }
  const config = validConfig(path, dir);
  config.omp.args = ['--model', '  quoted "$HOME"; echo not-a-command  '];
  writeConfig(config);
  assert.deepEqual(readConfig(path).omp.args, config.omp.args);
  const secret = 'never-echo-invalid-token';
  config.bots[0]!.token = secret;
  assert.throws(() => writeConfig(config), error => error instanceof ConfigError && !error.message.includes(secret));
  writeFileSync(path, `bots: [${secret}\n`);
  assert.throws(() => readConfig(path), error => error instanceof ConfigError && !error.message.includes(secret));
});

test('readonly file cannot be replaced through its writable parent, including privileged CLI', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  writeConfig(config);
  const before = readFileSync(path);
  chmodSync(path, 0o400);
  assert.equal(configWritable(path), false);
  assertInvalid(path, () => writeConfig(config));
  assert.deepEqual(readFileSync(path), before);
});

test('readonly parent blocks replacement and new nested configs', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  writeConfig(config);
  chmodSync(dir, 0o500);
  try {
    assert.equal(configWritable(path), false);
    assertInvalid(path, () => writeConfig(config));
    const nested = join(dir, 'not-created', 'config.yaml');
    assert.equal(configWritable(nested), false);
    assertInvalid(nested, () => writeConfig(emptyConfig(nested)));
    assert.equal(existsSync(dirname(nested)), false);
  } finally { chmodSync(dir, 0o700); }
});

test('atomic mutations preserve original mode and ownership', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  writeConfig(config);
  chmodSync(path, 0o640);
  if (process.getuid?.() === 0) chownSync(path, 65534, 65534);
  const before = statSync(path);
  config.port = 4000;
  writeConfig(config);
  const after = statSync(path);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.notEqual(after.ino, before.ino);
  assert.equal(readConfig(path).port, 4000);
});

test('symlink config and immediate symlink parent are never replaced', t => {
  const { path, dir } = fixture(t);
  const target = join(dir, 'target.yaml');
  writeConfig(emptyConfig(target));
  symlinkSync(target, path);
  assert.equal(configWritable(path), false);
  assertInvalid(path, () => readConfig(path));
  assertInvalid(path, () => writeConfig(emptyConfig(path)));
  assert.ok(lstatSync(path).isSymbolicLink());
  const link = join(dir, 'linked'); symlinkSync(dir, link);
  const other = join(link, 'other.yaml');
  assert.equal(configWritable(other), false);
  assertInvalid(other, () => writeConfig(emptyConfig(other)));
});
