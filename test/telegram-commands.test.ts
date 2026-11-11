import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTelegramCommand } from '../src/telegram-commands.js';

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
  for (const text of ['/unknown /new x', '/session', '/session@ExampleBot', '/constructor task', '/__proto__ task', '/p@OtherBot x', '/bad-command x']) assert.deepEqual(parse(text), { kind: 'ignore' });
  assert.deepEqual(parse('/p@eXAMPLEbOT hello'), { kind: 'prompt', action: 'p', text: 'hello', extensions: [] });
});

test('bare presets compose interactively and repeated extensions start literal text', () => {
  assert.deepEqual(parse('/p /model_preset'), {kind:'prompt',action:'p',text:'',extensions:[{kind:'model-preset'}]});
  assert.deepEqual(parse('/p /model_preset /worktree text'), {
    kind:'prompt',action:'p',text:'text',extensions:[{kind:'model-preset'},{kind:'worktree'}],
  });
  assert.deepEqual(parse('/p /model_preset a /model_preset b text'), {
    kind:'prompt',action:'p',text:'/model_preset b text',extensions:[{kind:'model-preset',name:'a'}],
  });
  assert.deepEqual(parse('/new /worktree /worktree text'), {
    kind:'prompt',action:'new',text:'/worktree text',extensions:[{kind:'worktree'}],
  });
  assert.deepEqual(parse('/p /worktree branch /stop'), {
    kind: 'prompt', action: 'p', text: 'branch /stop', extensions: [{ kind: 'worktree' }],
  });
});

test('all standalone command groups enforce their arities', () => {
  for (const action of ['settings', 'setup', 'list_admins', 'detach', 'agent', 'status', 'usage', 'stop', 'kill', 'terminate', 'help', 'cli']) {
    assert.deepEqual(parse(`/${action}`), { kind: 'command', action, argument: '' });
    for (const argument of ['extra', '/worktree', '/home/work/error.ts:27', '/unknown /kill']) {
      assert.equal(parse(`/${action} ${argument}`).kind, 'invalid');
    }
  }
  for (const action of ['worktree', 'model_preset']) {
    for (const argument of ['', 'named']) assert.deepEqual(parse(`/${action}${argument ? ` ${argument}` : ''}`), { kind: 'command', action, argument });
    assert.equal(parse(`/${action} one two`).kind, 'invalid');
    assert.equal(parse(`/${action} /stop`).kind, 'invalid');
  }
  assert.deepEqual(parse('/attach host label'), { kind: 'command', action: 'attach', argument: 'host label' });
  assert.deepEqual(parse('/attach host'), { kind: 'command', action: 'attach', argument: 'host' });
  assert.equal(parse('/attach').kind, 'invalid');
  assert.equal(parse('/attach /stop').kind, 'invalid');
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
  assert.deepEqual(parse('/p /start setup task'), {kind:'prompt',action:'p',text:'/start setup task',extensions:[]});
});


test('non-extension slash tokens start literal prompts without executing commands', () => {
  for (const action of ['new', 'p', 'skills', 'settings', 'setup', 'list_admins', 'attach', 'detach', 'agent', 'status', 'usage', 'stop', 'kill', 'terminate', 'help', 'start', 'cli', 'unknown', 'worktree@OtherBot']) {
    assert.deepEqual(parse(`/new /${action} text`), {kind:'prompt',action:'new',text:`/${action} text`,extensions:[]});
  }
});

test('malformed preset names are literal in prompts and validated in standalone commands', () => {
  for (const name of ['123', 'name.dot', 'bad!', '-name', '😀']) {
    assert.equal(parse(`/model_preset ${name}`).kind, 'invalid');
    assert.deepEqual(parse(`/new /model_preset ${name} prompt`), {kind:'prompt',action:'new',text:`/model_preset ${name} prompt`,extensions:[]});
  }
  assert.deepEqual(parse('/model_preset Good_name-2'), { kind: 'command', action: 'model_preset', argument: 'Good_name-2' });
});


test('pasted absolute paths and multiline diagnostics are literal prompt data', () => {
  const text = '/home/work/project/test/e2e/helpers/telegram-user.ts:27\n  throw new Error("Refusing to import a Telegram session outside the test network");\nError: Refusing to import a Telegram session outside the test network\n    at validateTelegramTestSession (/home/work/project/test/e2e/helpers/telegram-user.ts:27:11)';
  for (const root of ['/p', '/new', '/skill_review']) {
    assert.deepEqual(parse(`${root} ${text}`), {
      kind:'prompt',action:root === '/new' ? 'new' : 'p',text,
      extensions:root === '/skill_review' ? [{kind:'skill',name:'Review.Exact'}] : [],
    });
  }
  assert.deepEqual(parse(`/p /worktree /model_preset Fast ${text}`), {
    kind:'prompt',action:'p',text,extensions:[{kind:'worktree'},{kind:'model-preset',name:'Fast'}],
  });
});

test('interactive presets retain following skill selection and literal slash task boundaries', () => {
  assert.deepEqual(parse('/new /model_preset /skill_review /home/work/error.ts:27\n/stop'), {
    kind:'prompt',action:'new',text:'/home/work/error.ts:27\n/stop',
    extensions:[{kind:'model-preset'},{kind:'skill',name:'Review.Exact'}],
  });
  assert.deepEqual(parse('/p /model_preset /stop'), {
    kind:'prompt',action:'p',text:'/stop',extensions:[{kind:'model-preset'}],
  });
});
