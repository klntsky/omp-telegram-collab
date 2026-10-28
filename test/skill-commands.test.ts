import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMentionableSkillName, skillCommandAliases } from '../src/skill-commands.js';

test('skill aliases normalize names while retaining exact canonical entries and input order', () => {
  const skills = [
    { name: 'Native/Review.Code', description: 'Namespaced review' },
    { name: '__Deploy---NOW__', description: 'Deployment' },
    { name: 'a__b', description: 'Existing underscores' },
    { name: '123', description: 'Numeric' },
  ];
  const aliases = skillCommandAliases(skills);
  assert.deepEqual([...aliases.keys()], ['skill_native_review_code', 'skill_deploy_now', 'skill_a__b', 'skill_123']);
  assert.deepEqual([...aliases.values()], skills);
  assert.equal(aliases.get('skill_native_review_code'), skills[0]);
});

test('normalized and truncated collisions keep the first entry without hashing', () => {
  const first = { name: 'Review/Code', description: 'First' };
  const longFirst = { name: `${'a'.repeat(26)}-first`, description: 'First long name' };
  const aliases = skillCommandAliases([
    first,
    { name: 'review-code', description: 'Second' },
    { name: 'REVIEW.CODE', description: 'Third' },
    { name: first.name, description: 'Duplicate canonical name' },
    longFirst,
    { name: `${'a'.repeat(26)}-second`, description: 'Second long name' },
  ]);
  assert.deepEqual([...aliases], [
    ['skill_review_code', first],
    [`skill_${'a'.repeat(26)}`, longFirst],
  ]);
});

test('aliases obey Telegram ASCII and 32-character boundaries without limiting canonical names', () => {
  const skills = [25, 26, 27, 1000].map(length => ({ name: 'x'.repeat(length), description: String(length) }));
  const aliases = skillCommandAliases(skills);
  assert.deepEqual([...aliases.keys()].map(alias => alias.length), [31, 32]);
  assert.equal(aliases.get(`skill_${'x'.repeat(26)}`), skills[1]);
  for (const alias of aliases.keys()) assert.match(alias, /^[a-z0-9_]{1,32}$/);
  assert.equal(isMentionableSkillName('x'.repeat(1000)), true);
});

test('mentionable canonical names allow namespaces and Unicode but reject ambiguous characters', () => {
  for (const name of ['native/skill', '/nested/skill', '日本語', 'a:b', 'a-b', '_', 'x'.repeat(1000)]) {
    assert.equal(isMentionableSkillName(name), true, JSON.stringify(name));
  }
  for (const name of ['', 'two words', ' leading', 'trailing ', 'line\nbreak', 'tab\tname', 'back\\slash', 'a\u00a0b', 'a\u2028b']) {
    assert.equal(isMentionableSkillName(name), false, JSON.stringify(name));
  }
  for (let code = 0; code <= 0x9f; code++) {
    if (code > 0x1f && code < 0x7f) continue;
    assert.equal(isMentionableSkillName(`a${String.fromCharCode(code)}b`), false, `control ${code}`);
  }
});

test('unusable canonical and normalized-empty names do not reserve aliases', () => {
  const valid = { name: 'a-b', description: 'Usable' };
  const aliases = skillCommandAliases([
    ...['', '_', '___', '---', '日本語', 'a b', 'a\\b', 'a\u0000b'].map(name => ({ name, description: 'Unusable' })),
    valid,
  ]);
  assert.deepEqual([...aliases], [['skill_a_b', valid]]);
  assert.deepEqual([...skillCommandAliases([])], []);
});

test('alias generation leaves total menu capacity to the caller', () => {
  const skills = Array.from({ length: 101 }, (_, index) => ({ name: `name${index}`, description: '' }));
  assert.equal(skillCommandAliases(skills).size, 101);
});
