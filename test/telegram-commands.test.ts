import assert from 'node:assert/strict';
import test from 'node:test';
import { buildParser } from '@lezer/generator';
import { parseTelegramCommand, tokenizeTelegramCommand } from '../src/telegram-commands.js';

const aliases = new Map([['skill_review', { name: 'Review.Exact' }]]);
const parse = (text: string) => parseTelegramCommand(text, 'ExampleBot', aliases);

test('composed prompt grammar preserves the complete literal tail', () => {
  assert.deepEqual(parse('/new@ExampleBot /model_preset fast /worktree /skill:Case.Sensitive /skill_review explain\n  /stop /unknown'), {
    kind: 'prompt', action: 'new', text: 'explain\n  /stop /unknown', extensions: [
      { kind: 'model-preset', name: 'fast' }, { kind: 'worktree' },
      { kind: 'skill', name: 'Case.Sensitive' }, { kind: 'skill', name: 'Review.Exact' },
    ],
  });
});

test('skill aliases and canonical names are exact and deduplicated', () => {
  assert.deepEqual(parse('/skill_review'), { kind: 'command', action: 'skill_review', argument: '' });
  assert.deepEqual(parse('/skill:Case.Sensitive'), { kind: 'selection', name: 'Case.Sensitive' });
  assert.deepEqual(parse('/p /skill_review /skill:Review.Exact /skill:review.exact text'), {
    kind: 'prompt', action: 'p', text: 'text', extensions: [
      { kind: 'skill', name: 'Review.Exact' }, { kind: 'skill', name: 'review.exact' },
    ],
  });
});

test('unknown roots and wrong bot roots are ignored after full tokenization', () => {
  for (const text of ['/unknown /new x', '/constructor task', '/__proto__ task', '/p@OtherBot x', '/bad-command x']) assert.deepEqual(parse(text), { kind: 'ignore' });
  assert.deepEqual(parse('/p@eXAMPLEbOT hello'), { kind: 'prompt', action: 'p', text: 'hello', extensions: [] });
});

test('prefix boundaries and repeated singleton extensions reject', () => {
  for (const text of [
    '/new /unknown text', '/p /stop text', '/p /p text', '/p /model_preset',
    '/p /model_preset /worktree text', '/p /model_preset a /model_preset b text',
    '/new /worktree /worktree text', '/p /worktree@OtherBot text',
  ]) {
    const result = parse(text);
    assert.equal(result.kind, 'invalid', text);
    if (result.kind === 'invalid') assert.ok(result.error instanceof Error);
  }
  assert.deepEqual(parse('/p /worktree branch /stop'), {
    kind: 'prompt', action: 'p', text: 'branch /stop', extensions: [{ kind: 'worktree' }],
  });
});

test('all standalone command groups enforce their arities', () => {
  for (const action of ['settings', 'setup', 'list_admins', 'detach', 'session', 'status', 'usage', 'stop', 'kill', 'terminate', 'help', 'cli']) {
    assert.deepEqual(parse(`/${action}`), { kind: 'command', action, argument: '' });
    assert.equal(parse(`/${action} extra`).kind, 'invalid');
  }
  for (const action of ['worktree', 'model_preset']) {
    for (const argument of ['', 'named']) assert.deepEqual(parse(`/${action}${argument ? ` ${argument}` : ''}`), { kind: 'command', action, argument });
    assert.equal(parse(`/${action} one two`).kind, 'invalid');
  }
  assert.deepEqual(parse('/attach host label'), { kind: 'command', action: 'attach', argument: 'host label' });
  assert.deepEqual(parse('/attach host'), { kind: 'command', action: 'attach', argument: 'host' });
  assert.equal(parse('/attach').kind, 'invalid');
  assert.deepEqual(parse('/attach host topic name /literal'), { kind: 'command', action: 'attach', argument: 'host topic name /literal' });
  assert.deepEqual(parse('/skills clear'), { kind: 'command', action: 'skills', argument: 'clear' });
  assert.deepEqual(parse('/skills'), { kind: 'command', action: 'skills', argument: '' });
  assert.equal(parse('/skills unknown').kind, 'invalid');
  assert.deepEqual(parse('/new'), { kind: 'prompt', action: 'new', text: '', extensions: [] });
});

test('standalone start accepts deep-link payloads without becoming composable', () => {
  assert.deepEqual(parse('/start'), {kind:'command',action:'start',argument:''});
  assert.deepEqual(parse('/start@ExampleBot setup'), {kind:'command',action:'start',argument:'setup'});
  assert.deepEqual(parse('/start token_with-dashes'), {kind:'command',action:'start',argument:'token_with-dashes'});
  assert.equal(parse('/start one two').kind,'invalid');
  assert.equal(parse('/p /start setup task').kind,'invalid');
});

test('tokenization consumes every non-whitespace span with strictly advancing offsets', () => {
  const source = '/p\n /skill:Exact 😀\t/unknown@Else /stop';
  const tokens = tokenizeTelegramCommand(source, 'ExampleBot');
  let end = 0;
  for (const token of tokens) {
    assert.ok(token.start >= end);
    assert.ok(token.end > token.start);
    assert.equal(source.slice(token.start, token.end), token.image);
    assert.equal(source.slice(end, token.start).trim(), '');
    end = token.end;
  }
  assert.equal(source.slice(end).trim(), '');
});

test('generator rejects unresolved grammar conflicts rather than choosing alternatives', () => {
  assert.throws(() => buildParser('@top Request { Left | Right } Left { "x" } Right { "x" }'));
});

test('all non-extension slash commands reject before the prompt boundary', () => {
  for (const action of ['new', 'p', 'skills', 'settings', 'setup', 'list_admins', 'attach', 'detach', 'session', 'status', 'usage', 'stop', 'kill', 'terminate', 'help', 'start', 'cli']) {
    assert.equal(parse(`/new /${action} text`).kind, 'invalid', action);
  }
});

test('malformed preset names reject in both grammar contexts', () => {
  for (const name of ['123', 'name.dot', 'bad!', '-name', '😀']) {
    assert.equal(parse(`/model_preset ${name}`).kind, 'invalid');
    assert.equal(parse(`/new /model_preset ${name} prompt`).kind, 'invalid');
  }
  assert.deepEqual(parse('/model_preset Good_name-2'), { kind: 'command', action: 'model_preset', argument: 'Good_name-2' });
});

test('long prefixes terminate and deduplicate without changing literal tails', () => {
  const prefix = '/skill:Exact '.repeat(2000);
  assert.deepEqual(parse(`/p ${prefix}literal /stop`), {
    kind: 'prompt', action: 'p', text: 'literal /stop', extensions: [{ kind: 'skill', name: 'Exact' }],
  });
  assert.equal(parse(`/p ${prefix}/unknown`).kind, 'invalid');
  assert.equal(parse(`/p ${prefix}/worktree /worktree`).kind, 'invalid');
});

test('source-offset parser and tokenizer agree on whitespace boundaries', () => {
  for (const separator of [' ', '\t', '\r\n', '\u00a0', '\u2028', '\u2029', '\ufeff']) {
    const source = `/p${separator}/model_preset${separator}Fast${separator}Explain${separator}/stop`;
    assert.deepEqual(parse(source), {
      kind:'prompt',action:'p',text:`Explain${separator}/stop`,
      extensions:[{kind:'model-preset',name:'Fast'}],
    });
  }
});
