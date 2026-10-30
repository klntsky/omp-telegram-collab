import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { notifyReload, runAdmin, type AdminDependencies } from '../src/cli-admin.js';
import { canonicalPath, emptyConfig, readConfig, writeConfig } from '../src/config.js';
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
  const calls: {method: string; payload: Record<string, unknown>; botId: number}[] = [];
  const state = {forum: true, manageTopics: true, pinMessages: true, requesterStatus: 'administrator', requesterUsername: 'CurrentAdmin' as string | undefined, requesterId: 42, requesterBot: false, fail: '', failure: new Error('Telegram transport unavailable\nOriginal socket diagnostic')};
  const deps: AdminDependencies = {
    interactive: false,
    output: () => {},
    telegram: selectedToken => {
      const botId = Number(selectedToken.split(':')[0]);
      const record = (method: string, payload: Record<string, unknown>) => {
        calls.push({method, payload, botId});
        if (state.fail === method) throw state.failure;
      };
      return {
        async getMe() {
          record('getMe', {});
          return {id: botId, is_bot: true, username: `bot_${botId}`};
        },
        async getChat(chatId) {
          record('getChat', {chat_id: chatId});
          return {id: chatId, type: 'supergroup', is_forum: state.forum, title: 'Current verified forum; $(never execute)'};
        },
        async getChatMember(chatId, userId) {
          record('getChatMember', {chat_id: chatId, user_id: userId});
          return userId === botId
            ? {status: 'administrator', can_manage_topics: state.manageTopics, can_pin_messages: state.pinMessages}
            : {status: state.requesterStatus, user: {id: state.requesterId, is_bot: state.requesterBot, username: state.requesterUsername}};
        },
        async sendMessage(chatId, text) {
          record('sendMessage', {chat_id: chatId, text});
          return {message_id: 1};
        },
      };
    },
    environment: {BOT_TOKEN: token, SECOND_TOKEN: secondToken},
  };
  const run = (args: string[], overrides: AdminDependencies = {}) => runAdmin(args, configPath, {...deps, ...overrides});
  const seed = (multipleBots = false) => {
    const config = emptyConfig(configPath);
    config.bots = [{id: 123456789, token, miniAppShortName: 'app'}];
    if (multipleBots) config.bots.push({id: 987654321, token: secondToken, miniAppShortName: 'second'});
    config.instances[canonicalPath(project)] = {chats: []};
    writeConfig(config);
    return config;
  };
  const store = () => new Store(join(readConfig(configPath).dataDir, 'telegram.sqlite'));
  return {root, configPath, project, other, calls, state, deps, run, seed, store};
}

test('unhandled commands return false and reads never create a missing configuration', async t => {
  const f = fixture(t);
  assert.equal(await f.run(['start']), false);
  assert.equal(existsSync(f.configPath), false);
  await assert.rejects(f.run(['list']), /Cannot read/);
  assert.equal(await f.run(['admin', 'add', f.project, 'Alice']), false);
  assert.equal(existsSync(f.configPath), false);
});

test('create, list, show and remove use canonical directory identities', async t => {
  const f = fixture(t);
  const alias = join(f.root, 'alias');
  symlinkSync(f.project, alias);
  await f.run(['create', alias]);
  const path = canonicalPath(f.project);
  assert.deepEqual(Object.keys(readConfig(f.configPath).instances), [path]);
  assert.deepEqual(readConfig(f.configPath).instances[path], {chats: []});
  await assert.rejects(f.run(['create', f.project]), /already registered/);
  await assert.rejects(f.run(['create', f.other, '--admin', 'Alice']), /Unknown option/);
  await f.run(['list']);
  await f.run(['show', alias]);
  rmSync(f.project, {recursive: true});
  await f.run(['show', path]);
  await f.run(['remove', path]);
  assert.deepEqual(readConfig(f.configPath).instances, {});
});

test('explicit configure completes every service setting without hand editing', async t => {
  const f = fixture(t);
  const dataDir = join(f.root, 'selected data');
  await f.run(['configure', '--public-url', 'https://collab.example', '--host', '0.0.0.0', '--port', '4200', '--data-dir', dataDir, '--omp-executable', './bin/custom-omp', '--omp-arg', '--model', '--omp-arg', 'literal model with spaces', '--max-sessions', '12', '--startup-timeout-ms', '12345', '--relay-url', 'wss://relay.example']);
  const config = readConfig(f.configPath);
  assert.equal(config.publicUrl, 'https://collab.example');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 4200);
  assert.equal(config.dataDir, dataDir);
  assert.deepEqual(config.omp, {executable: resolve('./bin/custom-omp'), args: ['--model', 'literal model with spaces'], maxSessions: 12, startupTimeoutMs: 12345, relayUrl: 'wss://relay.example'});
  await f.run(['configure', '--clear-omp-args', '--relay-url', '-']);
  assert.deepEqual(readConfig(f.configPath).omp.args, []);
  assert.equal(readConfig(f.configPath).omp.relayUrl, undefined);
  await assert.rejects(f.run(['configure', '--port', '4000oops']), /Port must/);
  await assert.rejects(f.run(['configure', '--public-url', 'http://not-secure.example']), /Invalid configuration/);
  assert.equal(readConfig(f.configPath).port, 4200);
});

test('bot addition verifies identity without polling and supports stdin and environment tokens', async t => {
  const f = fixture(t);
  await f.run(['bot', 'add', '--token-stdin', '--mini-app-short-name', 'workspace'], {readToken: async () => `${token}\n`});
  await f.run(['bot', 'add', '--token-env', 'SECOND_TOKEN']);
  await f.run(['bot', 'list']);
  assert.equal(readConfig(f.configPath).bots.length, 2);
  assert.deepEqual(f.calls.map(call => call.method), ['getMe', 'getMe']);
  await assert.rejects(f.run(['bot', 'add', '--token-env', 'BOT_TOKEN']), /already configured/);
  await f.run(['bot', 'remove', '987654321']);
  assert.equal(readConfig(f.configPath).bots.length, 1);
});

test('Telegram transport errors preserve original multiline diagnostics without a partial config', async t => {
  const f = fixture(t);
  f.state.fail = 'getMe';
  await assert.rejects(f.run(['bot', 'add', '--token-env', 'BOT_TOKEN']), error => {
    assert.equal(error, f.state.failure);
    assert.equal((error as Error).message, 'Telegram transport unavailable\nOriginal socket diagnostic');
    return true;
  });
  assert.equal(existsSync(f.configPath), false);
});

test('multiple bots require a selector and one path can bind multiple bot/chat pairs', async t => {
  const f = fixture(t);
  f.seed(true);
  await assert.rejects(f.run(['chat', 'add', f.project, '--chat', '-1001']), /specify --bot ID/);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--bot', '123456789']);
  await f.run(['chat', 'add', f.project, '--chat', '-1002', '--bot', '123456789', '--all-messages-are-prompts', 'false', '--users-can-propose-prompts', 'true']);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--bot', '987654321', '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'true']);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [
    {botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false},
    {botId: 123456789, chatId: -1002, all_messages_are_prompts: false, users_can_propose_prompts: true},
    {botId: 987654321, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: true},
  ]);
  const store = f.store();
  assert.equal(store.isEnrolled(123456789, -1001), true);
  store.close();
  await f.run(['chat', 'list', f.project]);
  await f.run(['chat', 'remove', f.project, '--chat', '-1002', '--bot', '123456789']);
  assert.equal(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats.length, 2);
  await f.run(['bot', 'remove', '987654321']);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
});

test('chat add updates matching options independently and omissions preserve them', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', f.project, '--chat', '-1001']);
  await f.run(['chat', 'add', f.project, '--chat', '-1002']);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--users-can-propose-prompts', 'true']);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--all-messages-are-prompts', 'false']);
  await f.run(['chat', 'add', f.project, '--chat', '-1001']);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [
    {botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true},
    {botId: 123456789, chatId: -1002, all_messages_are_prompts: true, users_can_propose_prompts: false},
  ]);
  await f.run(['show', f.project]);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--all-messages-are-prompts', 'true']);
  assert.equal(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats[0]!.all_messages_are_prompts, true);
  assert.equal(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats[0]!.users_can_propose_prompts, true);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--users-can-propose-prompts', 'false']);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [
    {botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false},
    {botId: 123456789, chatId: -1002, all_messages_are_prompts: true, users_can_propose_prompts: false},
  ]);
});

test('chat add and approve reject invalid, missing and repeated prompt mode values without writes', async t => {
  const f = fixture(t);
  f.seed();
  const original = readFileSync(f.configPath, 'utf8');
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  for (const args of [
    ['chat', 'add', f.project, '--chat', '-1001'],
    ['approve', pending.code, '--path', f.project, '--yes'],
  ]) {
    for (const flag of ['--all-messages-are-prompts', '--users-can-propose-prompts']) {
      for (const value of ['yes', 'no', 'TRUE', 'False', '1', '0', '', ' true', 'false ']) {
        await assert.rejects(f.run([...args, flag, value]), /must be true or false/);
      }
      await assert.rejects(f.run([...args, flag]), /requires a value/);
      await assert.rejects(f.run([...args, flag, 'true', flag, 'false']), /only once/);
    }
  }
  await assert.rejects(f.run(['chat', 'remove', f.project, '--chat', '-1001', '--users-can-propose-prompts', 'false']), /only supported by chat add/);
  await assert.rejects(f.run(['chat', 'list', f.project, '--users-can-propose-prompts', 'false']), /Usage/);
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  assert.equal(f.calls.length, 0);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
});

test('interactive chat add selects both options with current defaults and flags skip each choice', async t => {
  const f = fixture(t);
  f.seed();
  const prompts: string[] = [];
  let answers = ['', ''];
  const interactive = {interactive: true, question: async (prompt: string) => { prompts.push(prompt); const next = answers.shift(); assert.notEqual(next, undefined); return next!; }};
  await f.run(['chat', 'add', f.project, '--chat', '-1001'], interactive);
  answers = ['false', 'true'];
  await f.run(['chat', 'add', f.project, '--chat', '-1001'], interactive);
  answers = ['', ''];
  await f.run(['chat', 'add', f.project, '--chat', '-1001'], interactive);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true}]);
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'false'], interactive);
  assert.equal(prompts.length, 6);
  answers = ['true'];
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--all-messages-are-prompts', 'false'], interactive);
  answers = [''];
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--users-can-propose-prompts', 'true'], interactive);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true}]);
});

test('invalid interactive proposal choices leave assignments and approval requests unchanged', async t => {
  const f = fixture(t);
  f.seed();
  const original = readFileSync(f.configPath, 'utf8');
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  for (const args of [
    ['chat', 'add', f.project, '--chat', '-1001', '--all-messages-are-prompts', 'true'],
    ['approve', pending.code, '--path', f.project, '--yes', '--all-messages-are-prompts', 'true'],
  ]) {
    await assert.rejects(f.run(args, {
      interactive: true,
      question: async () => 'yes',
    }), /--users-can-propose-prompts must be true or false/);
  }
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
});

test('direct chat assignment validates forum and bot permissions before writing or enrollment', async t => {
  const f = fixture(t);
  f.seed();
  for (const permission of ['forum', 'manageTopics', 'pinMessages'] as const) {
    f.state[permission] = false;
    await assert.rejects(f.run(['chat', 'add', f.project, '--chat', '-1001']), /Topics enabled|Manage Topics and Pin Messages/);
    f.state[permission] = true;
  }
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, []);
  const store = f.store();
  assert.equal(store.isEnrolled(123456789, -1001), false);
  store.close();
});

test('removed assignments retain histories and cannot be rebound to another directory', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', f.project, '--chat', '-1001']);
  const store = f.store();
  const session = store.createSession({botId: 123456789, chatId: -1001, threadId: 11, instancePath: canonicalPath(f.project)}, 'existing history');
  store.close();
  await f.run(['chat', 'remove', f.project, '--chat', '-1001']);
  await f.run(['create', f.other]);
  await assert.rejects(f.run(['chat', 'add', f.other, '--chat', '-1001']), /histories pinned/);
  await f.run(['chat', 'add', f.project, '--chat', '-1001']);
  await assert.rejects(f.run(['remove', f.project]), /chat assignments/);
  await f.run(['chat', 'remove', f.project, '--chat', '-1001']);
  await f.run(['remove', f.project]);
  const retained = f.store();
  assert.equal(retained.getSession(session.id)?.instancePath, canonicalPath(f.project));
  retained.close();
});

test('approval verifies live numeric identity, enrolls, confirms, then consumes', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, username: 'OldName', title: 'Old title'});
  store.close();
  await assert.rejects(f.run(['approve', pending.code, '--path', f.project]), /requires --yes/);
  await f.run(['approve', pending.code, '--path', f.project, '--yes']);
  const config = readConfig(f.configPath);
  assert.deepEqual(config.instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
  const approved = f.store();
  assert.equal(approved.getSetupRequest(pending.code), undefined);
  assert.equal(approved.isEnrolled(123456789, -1001), true);
  approved.close();
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1);
});

test('approval flags independently update existing options without duplicates and omissions preserve them', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', f.project, '--chat', '-1001']);
  for (const [mode, proposals, expectedMode, expectedProposals] of [
    ['false', 'true', false, true],
    [undefined, undefined, false, true],
    ['true', undefined, true, true],
    [undefined, 'false', true, false],
  ] as const) {
    const store = f.store();
    const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
    store.close();
    await f.run(['approve', pending.code, '--path', f.project, '--yes', ...(mode === undefined ? [] : ['--all-messages-are-prompts', mode]), ...(proposals === undefined ? [] : ['--users-can-propose-prompts', proposals])]);
    assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [
      {botId: 123456789, chatId: -1001, all_messages_are_prompts: expectedMode, users_can_propose_prompts: expectedProposals},
    ]);
  }
});

test('guided approval defaults to the current mode and explicit approval flags skip the choice', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', f.project, '--chat', '-1001', '--all-messages-are-prompts', 'false']);
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  const answers = ['approve', pending.code, f.project, '', 'true', 'yes', 'done'];
  const prompts: string[] = [];
  await f.run(['setup'], {
    interactive: true,
    question: async prompt => { prompts.push(prompt); const next = answers.shift(); assert.notEqual(next, undefined); return next!; },
  });
  assert.deepEqual(answers, []);
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true}]);
  const nextStore = f.store();
  const next = nextStore.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  nextStore.close();
  await f.run(['approve', next.code, '--path', f.project, '--yes', '--all-messages-are-prompts', 'true'], {
    interactive: true,
    question: async () => '',
  });
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: true}]);
  const explicitStore = f.store();
  const explicit = explicitStore.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  explicitStore.close();
  await f.run(['approve', explicit.code, '--path', f.project, '--yes', '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'false'], {
    interactive: true,
    question: async () => { assert.fail('An explicit prompt mode must not ask a question.'); },
  });
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
});

test('approval preserves requests when requester or bot permissions fail', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, username: 'OldName', title: 'Old title'});
  store.close();
  f.state.requesterStatus = 'member';
  await assert.rejects(f.run(['approve', pending.code, '--path', f.project, '--yes']), /no longer a current group administrator/);
  f.state.requesterStatus = 'administrator';
  f.state.pinMessages = false;
  await assert.rejects(f.run(['approve', pending.code, '--path', f.project, '--yes']), /Manage Topics and Pin Messages/);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
  assert.equal(f.calls.some(call => call.method === 'sendMessage'), false);
});

test('approval preserves request and configuration when config becomes readonly before write', async t => {
  const f = fixture(t);
  f.seed();
  const original = readFileSync(f.configPath, 'utf8');
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  await assert.rejects(f.run(['approve', pending.code, '--path', f.project, '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'false'], {
    interactive: true,
    question: async () => { chmodSync(f.configPath, 0o400); return 'yes'; },
  }), /read-only/);
  chmodSync(f.configPath, 0o600);
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
});

test('readonly file and readonly parent reject mutations but permit inspection', async t => {
  const f = fixture(t);
  f.seed();
  chmodSync(f.configPath, 0o400);
  await f.run(['list']);
  await assert.rejects(f.run(['configure', '--max-sessions', '50']), /read-only/);
  chmodSync(f.configPath, 0o600);
  chmodSync(f.root, 0o500);
  try { await assert.rejects(f.run(['configure', '--max-sessions', '50']), /read-only/); }
  finally { chmodSync(f.root, 0o700); }
  assert.equal(readConfig(f.configPath).omp.maxSessions, 8);
});

test('setup wizard completes service, bot, instance and chat workflows', async t => {
  const f = fixture(t);
  const answers = ['service', 'https://wizard.example', '127.0.0.1', '4555', join(f.root, 'wizard-data'), 'omp', '["--model","literal model"]', '9', '34567', 'wss://relay.example', 'bot', token, 'wizardapp', 'create', f.project, 'connect', f.project, '-1001', 'false', 'true', 'inspect', 'done'];
  const hidden: boolean[] = [];
  await f.run(['setup'], {interactive: true, question: async (_prompt, secret) => { hidden.push(Boolean(secret)); const next = answers.shift(); assert.notEqual(next, undefined); return next!; }});
  assert.deepEqual(answers, []);
  assert.equal(hidden.filter(Boolean).length, 1);
  const config = readConfig(f.configPath);
  assert.equal(config.publicUrl, 'https://wizard.example');
  assert.equal(config.bots[0]!.miniAppShortName, 'wizardapp');
  assert.deepEqual(config.omp.args, ['--model', 'literal model']);
  assert.deepEqual(config.instances[canonicalPath(f.project)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true}]);
});

test('interactive approval can register an existing directory and cancel without consuming', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  let answers = [f.other, '', '', 'no'];
  const prompts: string[] = [];
  const question = async (prompt: string) => { prompts.push(prompt); const next = answers.shift(); assert.notEqual(next, undefined); return next!; };
  await f.run(['approve', pending.code], {interactive: true, question});
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  preserved.close();
  answers = [f.other, 'false', 'true', 'yes'];
  await f.run(['approve', pending.code], {interactive: true, question});
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.other)]!.chats, [{botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true}]);
});

test('local approval registers a selected directory for a creator or administrator without a username', async t => {
  for (const status of ['creator', 'administrator']) {
    const f = fixture(t);
    f.seed();
    f.state.requesterStatus = status;
    f.state.requesterUsername = undefined;
    const store = f.store();
    const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
    store.close();
    await f.run(['approve', pending.code, '--path', f.other, '--yes']);
    assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.other)], {chats: [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]});
  }
});

test('approval rechecks authority but does not bind it to a username', async t => {
  for (const change of ['username', 'revocation', 'identity', 'bot']) {
    const f = fixture(t);
    f.seed();
    const source = readFileSync(f.configPath, 'utf8');
    const store = f.store();
    const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
    store.close();
    const approval = f.run(['approve', pending.code, '--path', f.other, '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'false'], {
      interactive: true,
      question: async () => {
          if (change === 'username') f.state.requesterUsername = 'RenamedAdmin';
          if (change === 'revocation') f.state.requesterStatus = 'member';
          if (change === 'identity') f.state.requesterId = 43;
          if (change === 'bot') f.state.requesterBot = true;
          return 'yes';
      },
    });
    if (change === 'username') {
      await approval;
      assert.ok(readConfig(f.configPath).instances[canonicalPath(f.other)]);
    } else {
      await assert.rejects(approval, /no longer a current group administrator/);
      assert.equal(readFileSync(f.configPath, 'utf8'), source);
      const preserved = f.store();
      assert.ok(preserved.getSetupRequest(pending.code));
      assert.equal(preserved.isEnrolled(123456789, -1001), false);
      preserved.close();
    }
  }
});

test('approval preserves original Telegram errors and leaves requests untouched', async t => {
  for (const method of ['getMe', 'getChat', 'getChatMember']) {
    const f = fixture(t);
    f.seed();
    const source = readFileSync(f.configPath, 'utf8');
    const store = f.store();
    const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
    store.close();
    f.state.fail = method;
    await assert.rejects(f.run(['approve', pending.code, '--path', f.other, '--yes']), error => {
      assert.equal(error, f.state.failure);
      return true;
    });
    assert.equal(readFileSync(f.configPath, 'utf8'), source);
    const preserved = f.store();
    assert.ok(preserved.getSetupRequest(pending.code));
    preserved.close();
  }
});

test('configuration writes notify the old data directory and do not roll back failed reloads', async t => {
  const f = fixture(t);
  const initial = f.seed();
  const nextData = join(f.root, 'next-data');
  const seen: string[] = [];
  await assert.rejects(f.run(['configure', '--data-dir', nextData], {reload: async (config, previous) => { seen.push(previous); assert.equal(config.dataDir, nextData); throw new Error('Configuration saved, but service restart failed'); }}), /saved/);
  assert.deepEqual(seen, [initial.dataDir]);
  assert.equal(readConfig(f.configPath).dataDir, nextData);
});

test('reload notification requires an acknowledgement from the selected service socket', async t => {
  const f = fixture(t);
  const config = f.seed();
  mkdirSync(config.dataDir, {recursive: true});
  let received: unknown;
  let status = 200;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/reload');
    assert.equal(req.method, 'POST');
    let text = '';
    for await (const chunk of req) text += String(chunk);
    received = JSON.parse(text);
    res.writeHead(status, {'content-type': 'application/json'});
    res.end(JSON.stringify(status === 200 ? {ok: true} : {error: 'wrong config'}));
  });
  server.listen(join(config.dataDir, 'control.sock'));
  await once(server, 'listening');
  try {
    await notifyReload(config);
    assert.deepEqual(received, {configPath: f.configPath});
    status = 409;
    await assert.rejects(notifyReload(config), /Configuration saved/);
  } finally { server.close(); await once(server, 'close'); }
});

test('interactive multi-bot chat connection selects the requested bot without starting a poller', async t => {
  const f = fixture(t);
  f.seed(true);
  const answers = ['987654321', '', ''];
  await f.run(['chat', 'add', f.project, '--chat', '-1001'], {interactive: true, question: async () => answers.shift()!});
  assert.deepEqual(readConfig(f.configPath).instances[canonicalPath(f.project)]!.chats, [{botId: 987654321, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
  assert.equal(f.calls.every(call => call.botId === 987654321), true);
  assert.equal(f.calls.some(call => call.method === 'getUpdates'), false);
});

