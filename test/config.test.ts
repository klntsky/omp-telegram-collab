import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { stringify } from 'yaml';
import type { AppConfig } from '../shared/contracts.js';
import { canonicalPath, ConfigError, configWritable, emptyConfig, readConfig, validateStart, writeConfig } from '../src/config.js';
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
  config.instances = [{ id: 1, defaultDir: directory, chats: [{ botId, chatId }] }];
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

test('Telegram-only configurations start without Mini App names while enabled configurations require them', t => {
  const { path } = fixture(t);
  const config = emptyConfig(path);
  config.bots = [{ id: botId, token: botToken }];
  writeConfig(config);
  validateStart(readConfig(path));
  config.publicUrl = 'https://collab.example.com';
  assertInvalid(path, () => writeConfig(config), 'bots');
  config.bots[0]!.miniAppShortName = 'app';
  writeConfig(config);
  validateStart(readConfig(path));
  config.bots[0]!.miniAppShortName = 'not valid';
  assertInvalid(path, () => writeConfig(config));
});

test('missing config is never an implicit empty draft', t => {
  const { path } = fixture(t);
  assertInvalid(path, () => readConfig(path));
  assert.equal(existsSync(path), false);
});

test('folder options reject absolute, empty, NUL, malformed and obsolete configuration', t => {
  const { path, dir } = fixture(t);
  const { configPath: _, ...input } = validConfig(path, dir);
  for (const fields of [
    { require_folder_choice: false }, { require_folder_choice: true },
    { folder_options: 'not-an-array' }, { folder_options: [1] }, { folder_options: null },
    { folder_options: [''] }, { folder_options: ['   '] },
    { folder_options: [dir] }, { folder_options: [`${dir}/../project`] },
    { folder_options: ['bad\0path'] },
  ]) {
    writeFileSync(path, stringify({ ...input, instances: [{ id: 1, defaultDir: dir, chats: [{ botId, chatId, ...fields }] }] }));
    assertInvalid(path, () => readConfig(path));
  }
});

test('obsolete administrator configuration keys are rejected', t => {
  const { path, dir } = fixture(t);
  const { configPath: _, ...input } = validConfig(path, dir);
  for (const admins of [[], ['alice'], [42]]) {
    writeFileSync(path, stringify({ ...input, bots: [{ ...input.bots[0], admins }] }));
    assertInvalid(path, () => readConfig(path), 'bots.0');
    writeFileSync(path, stringify({ ...input, instances: [{ ...input.instances[0], admins }] }));
    assertInvalid(path, () => readConfig(path), `instances.0`);
  }
});

test('forum model defaults reject names outside the native preset-name grammar', t => {
  const { path, dir } = fixture(t);
  const { configPath: _configPath, ...config } = validConfig(path, dir);
  for (const default_model_preset of ['', '1Fast', '../Fast', 'Fast/Slow', 'Fast Slow', 'Fast.Slow', true, 1, null, [], {}]) {
    writeFileSync(path, stringify({
      ...config,
      instances: [{ id: 1, defaultDir: dir, chats: [{ botId, chatId, default_model_preset }] }],
    }));
    assertInvalid(path, () => readConfig(path), `instances.0.chats.0.default_model_preset`);
  }
});

test('new-topic skill defaults reject whitespace, controls, backslashes, and nonstrings without normalization', t => {
  const { path, dir } = fixture(t);
  const { configPath: _configPath, ...config } = validConfig(path, dir);
  for (const invalidSkill of ['', ' Review', 'Review ', 'Two Names', 'Two\tNames', 'Two\nNames',
    'Two\u00a0Names', 'Two\u0000Names', 'Two\u001fNames', 'Two\u007fNames', 'Two\u0085Names',
    'Team\\Review', true, 1, null, [], {}]) {
    writeFileSync(path, stringify({
      ...config,
      instances: [{ id: 1, defaultDir: dir, chats: [{ botId, chatId, default_new_topic_skills: [invalidSkill] }] }],
    }));
    assertInvalid(path, () => readConfig(path), `instances.0.chats.0.default_new_topic_skills.0`);
  }
});

test('new-topic defaults require unique skill arrays and preserve selection order', t => {
  const { path, dir } = fixture(t);
  const { configPath: _configPath, ...config } = validConfig(path, dir);
  for (const default_new_topic_skills of ['Review', null, {}, ['Review', 'Review']]) {
    writeFileSync(path, stringify({
      ...config,
      instances: [{ id: 1, defaultDir: dir, chats: [{ botId, chatId, default_new_topic_skills }] }],
    }));
    assertInvalid(path, () => readConfig(path), 'instances.0.chats.0.default_new_topic_skills');
  }
  for (const default_new_topic_skills of [[], ['Review', 'Plan']]) {
    writeFileSync(path, stringify({
      ...config,
      instances: [{ id: 1, defaultDir: dir, chats: [{ botId, chatId, default_new_topic_skills }] }],
    }));
    assert.deepEqual(readConfig(path).instances[0]!.chats[0]!.default_new_topic_skills, default_new_topic_skills);
  }
});

test('YAML defaults forum boolean options independently and rejects nonboolean values', t => {
  const { path, dir } = fixture(t);
  const { configPath: _configPath, ...config } = validConfig(path, dir);
  writeFileSync(path, stringify(config));
  assert.equal(readConfig(path).instances[0]!.chats[0]!.all_messages_are_prompts, true);
  assert.equal(readConfig(path).instances[0]!.chats[0]!.users_can_propose_prompts, false);
  assert.equal(readConfig(path).instances[0]!.chats[0]!.create_topic_worktrees, false);
  for (const option of ['all_messages_are_prompts', 'users_can_propose_prompts', 'create_topic_worktrees']) {
    for (const mode of ['true', 'false', '', 0, 1, null, [], {}]) {
      writeFileSync(path, stringify({
        ...config,
        instances: [{ id: 1, defaultDir: dir, chats: [{ botId, chatId, [option]: mode }] }],
      }));
      assertInvalid(path, () => readConfig(path), `instances.0.chats.0.${option}`);
    }
  }
});

test('default directories must remain existing canonical directories when reading and writing', t => {
  const { path, dir } = fixture(t);
  const original = join(dir, 'original');
  const other = join(dir, 'other');
  const alias = join(dir, 'alias');
  mkdirSync(original); mkdirSync(other); symlinkSync(original, alias);
  assert.equal(canonicalPath(alias), original);
  const config = validConfig(path, original);
  writeConfig(config);
  rmSync(original, { recursive: true });
  assertInvalid(path, () => readConfig(path), 'instances');
  assertInvalid(path, () => writeConfig(config), 'instances');
  assert.throws(() => readConfig(path), /ENOENT/);
  symlinkSync(other, original);
  assertInvalid(path, () => readConfig(path), 'instances');
  assertInvalid(path, () => writeConfig(config), 'instances');
  config.instances[0]!.defaultDir = other;
  writeConfig(config);
  assert.equal(readConfig(path).instances[0]!.id, 1);
  assert.equal(readConfig(path).instances[0]!.defaultDir, other);
});

test('duplicate YAML path keys and normalized-path aliases are rejected', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  const { configPath: _configPath, ...value } = config;
  const source = stringify(value);
  writeFileSync(path, source.replace('instances:\n', `instances:\n  ${JSON.stringify(dir)}: {chats: []}\n`));
  assertInvalid(path, () => readConfig(path));
  config.instances.push({ id: 2, defaultDir: `${dir}/../${dir.split('/').at(-1)}`, chats: [] });
  assertInvalid(path, () => writeConfig(config));
});

test('instance IDs are required unique positive safe integers and duplicate directories are allowed', t => {
  const { path, dir } = fixture(t);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, '1']) {
    const { configPath: _, ...config } = validConfig(path, dir);
    writeFileSync(path, stringify({...config, instances: [{id, defaultDir: dir, chats: []}]}));
    assertInvalid(path, () => readConfig(path));
  }
  const config = validConfig(path, dir);
  config.instances.push({id: 1, defaultDir: dir, chats: []});
  assertInvalid(path, () => writeConfig(config), 'instances');
  config.instances[1]!.id = 2;
  writeConfig(config);
  assert.deepEqual(readConfig(path).instances.map(instance => instance.id), [1, 2]);
});

test('new stored paths reject symlink aliases and missing directories rather than inventing identities', t => {
  const { path, dir } = fixture(t);
  const config = validConfig(path, dir);
  const alias = join(dir, 'alias');
  symlinkSync(dir, alias);
  config.instances.push({ id: 2, defaultDir: alias, chats: [] });
  assertInvalid(path, () => writeConfig(config), 'instances');
  config.instances.pop();
  config.instances.push({ id: 2, defaultDir: join(dir, 'missing'), chats: [] });
  assertInvalid(path, () => writeConfig(config), 'instances');
  assert.equal(existsSync(path), false);
});

test('duplicate bot IDs, tokens, chat assignments and missing referenced bots fail validation', t => {
  const { path, dir } = fixture(t);
  for (const change of [
    (config: AppConfig) => { config.bots.push({ ...config.bots[0]! }); },
    (config: AppConfig) => { config.bots.push({ ...config.bots[0]!, token: `${botId}:different-token` }); },
    (config: AppConfig) => { config.bots[0]!.id = 42; },
    (config: AppConfig) => { config.instances.push({ id: 2, defaultDir: dir, chats: [{ botId, chatId }] }); },
    (config: AppConfig) => { config.instances[0]!.chats.push({ botId: 42, chatId: -42 }); },
    (config: AppConfig) => { config.instances[0]!.chats.push({ botId, chatId }); },
  ]) {
    const config = validConfig(path, dir);
    change(config);
    assertInvalid(path, () => writeConfig(config));
  }
});

test('YAML validates public origins, runtime fields and literal arguments without exposing secrets', t => {
  const { path, dir } = fixture(t);
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#fragment']) {
    const config = validConfig(path, dir); config.publicUrl = url;
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
