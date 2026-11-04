import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { notifyReload, runAdmin, type AdminDependencies } from '../src/cli-admin.js';
import { canonicalPath, ConfigError, emptyConfig, readConfig, writeConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { InstanceConfig } from '../shared/contracts.js';

const token = '123456789:fixture_token_never_live';
const secondToken = '987654321:second_fixture_token_never_live';

function assignmentPolicies(chats: InstanceConfig['chats']) {
  return chats.map(({botId, chatId, all_messages_are_prompts, users_can_propose_prompts}) => ({
    botId, chatId, all_messages_are_prompts, users_can_propose_prompts,
  }));
}

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
    config.instances.push({id: 1, defaultDir: canonicalPath(project), chats: []});
    writeConfig(config);
    return config;
  };
  const store = () => new Store(join(readConfig(configPath).dataDir, 'telegram.sqlite'));
  return {root, configPath, project, other, calls, state, deps, run, seed, store};
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
  assert.equal(f.calls.length, 0);
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

test('changing Mini App mode preserves registered names and fills only missing names', async t => {
  const f = fixture(t);
  await f.run(['setup', '--public-url', 'https://collab.example']);
  await f.run(['bot', 'add', '--token-env', 'BOT_TOKEN', '--mini-app-short-name', 'workspace']);
  await f.run(['setup', '--public-url', '']);
  assert.equal(readConfig(f.configPath).publicUrl, '');
  assert.equal(readConfig(f.configPath).bots[0]!.miniAppShortName, 'workspace');
  await f.run(['bot', 'add', '--token-env', 'SECOND_TOKEN']);
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
  await f.run(['bot', 'add', '--token-env', 'BOT_TOKEN']);
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
  await assert.rejects(f.run(['chat', 'add', '1', '--chat', '-1001']), /specify --bot ID/);
  await f.run(['chat', 'add', '1', '--chat', '-1001', '--bot', '123456789']);
  await f.run(['chat', 'add', '1', '--chat', '-1002', '--bot', '123456789', '--all-messages-are-prompts', 'false', '--users-can-propose-prompts', 'true']);
  await f.run(['chat', 'add', '1', '--chat', '-1001', '--bot', '987654321', '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'true']);
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [
    {botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false},
    {botId: 123456789, chatId: -1002, all_messages_are_prompts: false, users_can_propose_prompts: true},
    {botId: 987654321, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: true},
  ]);
  const store = f.store();
  assert.equal(store.isEnrolled(123456789, -1001), true);
  store.close();
  await f.run(['chat', 'list', '1']);
  await f.run(['chat', 'remove', '1', '--chat', '-1002', '--bot', '123456789']);
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [
    {botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false},
    {botId: 987654321, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: true},
  ]);
  await f.run(['bot', 'remove', '987654321']);
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
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
  assert.equal(f.calls.length, 0);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
});

test('invalid interactive chat proposal choices leave assignments and approval requests unchanged', async t => {
  const f = fixture(t);
  f.seed();
  const original = readFileSync(f.configPath, 'utf8');
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  await assert.rejects(f.run(['chat', 'add', '1', '--chat', '-1001', '--all-messages-are-prompts', 'true'], {
    interactive: true,
    question: async () => 'yes',
  }), /--users-can-propose-prompts must be true or false/);
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
    await assert.rejects(f.run(['chat', 'add', '1', '--chat', '-1001']), /Topics enabled|Manage Topics and Pin Messages/);
    f.state[permission] = true;
  }
  assert.deepEqual(readConfig(f.configPath).instances[0]!.chats, []);
  const store = f.store();
  assert.equal(store.isEnrolled(123456789, -1001), false);
  store.close();
});

test('removed assignments retain histories and cannot be rebound to another directory', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', '1', '--chat', '-1001']);
  const store = f.store();
  const session = store.createSession({botId: 123456789, chatId: -1001, threadId: 11, instanceId: 1, cwd: canonicalPath(f.project)}, 'existing history');
  store.close();
  await f.run(['chat', 'remove', '1', '--chat', '-1001']);
  await f.run(['create', f.other]);
  await assert.rejects(f.run(['chat', 'add', '2', '--chat', '-1001']), /histories pinned/);
  await f.run(['chat', 'add', '1', '--chat', '-1001']);
  await assert.rejects(f.run(['remove', '1']), /chat assignments/);
  await f.run(['chat', 'remove', '1', '--chat', '-1001']);
  await f.run(['remove', '1']);
  const retained = f.store();
  assert.equal(retained.getSession(session.id)?.instanceId, 1);
  retained.close();
  await f.run(['create', f.other]);
  assert.equal(readConfig(f.configPath).instances.at(-1)!.id, 3);
  await assert.rejects(f.run(['create', f.other, '--id', '1']), /retained in history/);
});

test('approval paths create distinct identities and stored histories reject reassignment even at the same directory', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  await f.run(['approve', pending.code, '--path', f.project, '--yes']);
  const config = readConfig(f.configPath);
  assert.deepEqual(config.instances.map(instance => [instance.id, instance.defaultDir]), [[1, canonicalPath(f.project)], [2, canonicalPath(f.project)]]);
  assert.equal(config.instances[0]!.chats.length, 0);
  assert.equal(config.instances[1]!.chats[0]!.chatId, -1001);
  const history = f.store();
  history.createSession({botId: 123456789, chatId: -1001, threadId: 12, instanceId: 2, cwd: canonicalPath(f.project)}, 'history');
  const repeated = history.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  history.close();
  await assert.rejects(f.run(['approve', repeated.code, '--path', f.other, '--yes']), /different default directory/);
  await f.run(['approve', repeated.code, '--path', f.project, '--yes']);
  assert.equal(readConfig(f.configPath).instances.length, 2);
  await f.run(['chat', 'remove', '2', '--chat', '-1001']);
  await assert.rejects(f.run(['chat', 'add', '1', '--chat', '-1001']), /histories pinned/);
});

test('approval verifies live numeric identity, enrolls, confirms, then consumes', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, username: 'OldName', title: 'Old title'});
  store.close();
  await assert.rejects(f.run(['approve', pending.code, '--instance', '1']), /requires --yes/);
  await f.run(['approve', pending.code, '--instance', '1', '--yes']);
  const config = readConfig(f.configPath);
  assert.deepEqual(assignmentPolicies(config.instances[0]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
  const approved = f.store();
  assert.equal(approved.getSetupRequest(pending.code), undefined);
  assert.equal(approved.isEnrolled(123456789, -1001), true);
  approved.close();
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1);
});

test('generated setup codes remain valid approval arguments when random bytes encode a leading hyphen', async t => {
  const f = fixture(t);
  f.seed();
  const random = t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 0xfb));
  syncBuiltinESMExports();
  t.after(() => { random.mock.restore(); syncBuiltinESMExports(); });
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();

  await f.run(['approve', pending.code, '--instance', '1', '--yes']);

  assert.ok(readConfig(f.configPath).instances[0]!.chats.some(
    chat => chat.botId === 123456789 && chat.chatId === -1001,
  ));
  const approved = f.store();
  assert.equal(approved.isEnrolled(123456789, -1001), true);
  assert.equal(approved.getSetupRequest(pending.code), undefined);
  approved.close();
});

test('approval flags independently update existing options without duplicates and omissions preserve them', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', '1', '--chat', '-1001']);
  for (const [mode, proposals, expectedMode, expectedProposals] of [
    ['false', 'true', false, true],
    [undefined, undefined, false, true],
    ['true', undefined, true, true],
    [undefined, 'false', true, false],
  ] as const) {
    const store = f.store();
    const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
    store.close();
    await f.run(['approve', pending.code, '--instance', '1', '--yes', ...(mode === undefined ? [] : ['--all-messages-are-prompts', mode]), ...(proposals === undefined ? [] : ['--users-can-propose-prompts', proposals])]);
    assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [
      {botId: 123456789, chatId: -1001, all_messages_are_prompts: expectedMode, users_can_propose_prompts: expectedProposals},
    ]);
  }
});

test('interactive approval preserves both current policies and explicit flags update choices without prompts', async t => {
  const f = fixture(t);
  f.seed();
  await f.run(['chat', 'add', '1', '--chat', '-1001', '--all-messages-are-prompts', 'false', '--users-can-propose-prompts', 'true']);
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  const answers = ['yes'];
  await f.run(['approve', pending.code, '--instance', '1'], {
    interactive: true,
    question: async () => { const next = answers.shift(); assert.notEqual(next, undefined); return next!; },
  });
  assert.deepEqual(answers, []);
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: false, users_can_propose_prompts: true}]);
  const nextStore = f.store();
  const next = nextStore.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  nextStore.close();
  await f.run(['approve', next.code, '--instance', '1', '--yes', '--all-messages-are-prompts', 'true'], {
    interactive: true,
    question: async () => { assert.fail('Explicit approval must not ask any questions'); },
  });
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: true}]);
  const explicitStore = f.store();
  const explicit = explicitStore.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  explicitStore.close();
  await f.run(['approve', explicit.code, '--instance', '1', '--yes', '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'false'], {
    interactive: true,
    question: async () => { assert.fail('Explicit approval must not ask any questions'); },
  });
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[0]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
});

test('approval preserves requests when requester or bot permissions fail', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, username: 'OldName', title: 'Old title'});
  store.close();
  f.state.requesterStatus = 'member';
  await assert.rejects(f.run(['approve', pending.code, '--instance', '1', '--yes']), /no longer a current group administrator/);
  f.state.requesterStatus = 'administrator';
  f.state.pinMessages = false;
  await assert.rejects(f.run(['approve', pending.code, '--instance', '1', '--yes']), /Manage Topics and Pin Messages/);
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
  await assert.rejects(f.run(['approve', pending.code, '--instance', '1', '--all-messages-are-prompts', 'true', '--users-can-propose-prompts', 'false'], {
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

test('interactive approval can register an existing directory and cancel without consuming', async t => {
  const f = fixture(t);
  f.seed();
  const store = f.store();
  const pending = store.createSetupRequest({botId: 123456789, chatId: -1001, userId: 42, title: 'Forum'});
  store.close();
  const original = readFileSync(f.configPath, 'utf8');
  let answers = [f.other, 'no'];
  const question = async () => { const next = answers.shift(); assert.notEqual(next, undefined); return next!; };
  await f.run(['approve', pending.code], {interactive: true, question});
  assert.deepEqual(answers, []);
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  const preserved = f.store();
  assert.ok(preserved.getSetupRequest(pending.code));
  assert.equal(preserved.isEnrolled(123456789, -1001), false);
  preserved.close();
  answers = [f.other, 'yes'];
  await f.run(['approve', pending.code], {interactive: true, question});
  assert.deepEqual(answers, []);
  assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[1]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
  const approved = f.store();
  assert.equal(approved.getSetupRequest(pending.code), undefined);
  assert.equal(approved.isEnrolled(123456789, -1001), true);
  approved.close();
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
    assert.deepEqual(assignmentPolicies(readConfig(f.configPath).instances[1]!.chats), [{botId: 123456789, chatId: -1001, all_messages_are_prompts: true, users_can_propose_prompts: false}]);
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
      assert.ok(readConfig(f.configPath).instances[1]);
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

