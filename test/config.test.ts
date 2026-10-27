import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ConfigError, getBotToken, loadConfig } from '../src/config.js';
import { botToken } from './telegram-data.js';

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_OWNER_USERNAMES: '@AliceOwner, BOB_OWNER, aliceowner',
    PUBLIC_URL: 'https://collab.example.com/',
    ...extra,
  };
}

function invalid(env: NodeJS.ProcessEnv, key: string) {
  assert.throws(() => loadConfig(env), error => error instanceof ConfigError && error.keys.includes(key));
}

test('missing environment configuration reports all required keys without guessing an owner or URL', () => {
  assert.throws(() => loadConfig({}), error => {
    assert.ok(error instanceof ConfigError);
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_USERNAMES', 'PUBLIC_URL']) assert.ok(error.keys.includes(key));
    return true;
  });
});

test('owner usernames accept @ and case variants without creating duplicate owners', () => {
  const config = loadConfig(environment());
  assert.deepEqual(config.bots[0]?.ownerUsernames, ['aliceowner', 'bob_owner']);
  assert.equal(config.publicUrl, 'https://collab.example.com');
});

test('empty, numeric, malformed, and obsolete ID-only owner configuration cannot grant access', () => {
  for (const owners of ['', ' ', '123456789', '@@aliceowner', 'alice owner', 'alice@example.com', 'aliceowner,', 'a'.repeat(33)]) {
    invalid(environment({ TELEGRAM_OWNER_USERNAMES: owners }), 'TELEGRAM_OWNER_USERNAMES');
  }
  invalid(environment({ TELEGRAM_OWNER_USERNAMES: undefined, TELEGRAM_OWNER_IDS: '42' }), 'TELEGRAM_OWNER_USERNAMES');
});

test('blank optional values behave as unset rather than coercing numeric limits to zero', () => {
  const unset = loadConfig(environment());
  const blank = loadConfig(environment({ HOST: '', PORT: ' ', DATA_DIR: '', OMP_EXECUTABLE: '', OMP_CWD: '', OMP_MAX_SESSIONS: '', OMP_STARTUP_TIMEOUT_MS: '', OMP_RELAY_URL: '', TELEGRAM_MINI_APP_SHORT_NAME: '' }));
  assert.deepEqual(blank, unset);
  assert.ok(blank.port > 0);
  assert.ok(blank.omp.maxSessions > 0);
  assert.ok(blank.omp.startupTimeoutMs > 0);
});

test('numeric settings reject partial, fractional, negative, and out-of-range values', () => {
  for (const value of ['3000oops', '2e3', '1.5', '-1', '65536']) invalid(environment({ PORT: value }), 'PORT');
  for (const key of ['OMP_MAX_SESSIONS', 'OMP_STARTUP_TIMEOUT_MS']) {
    for (const value of ['0', '-1', '2.5', 'nope', '9007199254740992']) invalid(environment({ [key]: value }), key);
  }
  assert.equal(loadConfig(environment({ PORT: '0' })).port, 0);
});

test('public URL requires an HTTPS origin without credentials, paths, queries, or fragments', () => {
  for (const value of ['http://collab.example.com', 'https://user:password@collab.example.com', 'https://collab.example.com/app', 'https://collab.example.com/?query=1', 'https://collab.example.com/#secret']) {
    invalid(environment({ PUBLIC_URL: value }), 'PUBLIC_URL');
  }
});

test('relative runtime paths resolve against the launch directory without splitting spaces', () => {
  const cwd = resolve('/tmp', 'omp-env-config-test');
  const config = loadConfig(environment({ DATA_DIR: 'private data', OMP_CWD: 'project repo' }), cwd);
  assert.equal(config.dataDir, resolve(cwd, 'private data'));
  assert.equal(config.omp.cwd, resolve(cwd, 'project repo'));
});

test('numbered OMP arguments retain literal contents and numeric ordering', () => {
  const literal = '  quoted "$HOME"; echo not-a-command  ';
  const config = loadConfig(environment({ OMP_ARG_10: literal, OMP_ARG_2: 'model with spaces', OMP_ARG_1: '--model', OMP_ARG_3: '' }));
  assert.deepEqual(config.omp.args, ['--model', 'model with spaces', literal]);
  invalid(environment({ OMP_ARG_01: '--model' }), 'OMP_ARG_01');
});

test('named bots retain distinct tokens and owners without falling back to primary credentials', () => {
  const secondToken = '987654321:second-fixture-token-not-valid-on-telegram';
  const env = environment({
    TELEGRAM_BOT_NAMES: 'work, Personal',
    TELEGRAM_WORK_BOT_TOKEN: botToken,
    TELEGRAM_WORK_OWNER_USERNAMES: '@WorkOwner',
    TELEGRAM_PERSONAL_BOT_TOKEN: secondToken,
    TELEGRAM_PERSONAL_OWNER_USERNAMES: 'PersonalOwner',
  });
  const config = loadConfig(env);
  assert.deepEqual(config.bots.map(bot => [bot.tokenEnv, bot.ownerUsernames]), [
    ['TELEGRAM_WORK_BOT_TOKEN', ['workowner']], ['TELEGRAM_PERSONAL_BOT_TOKEN', ['personalowner']],
  ]);
  assert.equal(getBotToken(config.bots[1]!, env), secondToken);
  invalid({ ...env, TELEGRAM_PERSONAL_OWNER_USERNAMES: undefined }, 'TELEGRAM_PERSONAL_OWNER_USERNAMES');
  invalid({ ...env, TELEGRAM_PERSONAL_BOT_TOKEN: undefined }, 'TELEGRAM_PERSONAL_BOT_TOKEN');
  invalid({ ...env, TELEGRAM_BOT_NAMES: 'work,WORK' }, 'TELEGRAM_BOT_NAMES');
});

test('configuration diagnostics identify bad token keys without echoing their contents', () => {
  const secret = 'do-not-echo-this-invalid-private-token';
  assert.throws(() => loadConfig(environment({ TELEGRAM_BOT_TOKEN: secret })), error => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.keys.includes('TELEGRAM_BOT_TOKEN'));
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});
