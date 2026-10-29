import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

test('skill catalogs are snapshots isolated by exact instance path', () => {
  const store = new Store(':memory:');
  const first = [{ name: 'Exact-Skill_Name', description: 'First description' }];
  const second = [{ name: 'other-skill', description: 'Other description' }];
  try {
    assert.equal(store.getSkillCatalog('/work/project'), undefined);
    store.setSkillCatalog('/work/project', first);
    store.setSkillCatalog('/work/project/', second);
    assert.deepEqual(store.getSkillCatalog('/work/project'), first);
    assert.deepEqual(store.getSkillCatalog('/work/project/'), second);
    assert.equal(store.getSkillCatalog('/work/Project'), undefined);
    first[0]!.description = 'Changed after saving';
    assert.deepEqual(store.getSkillCatalog('/work/project'), [{ name: 'Exact-Skill_Name', description: 'First description' }]);
    store.setSkillCatalog('/work/project', second);
    assert.deepEqual(store.getSkillCatalog('/work/project'), second);
    store.setSkillCatalog('/work/project', []);
    assert.deepEqual(store.getSkillCatalog('/work/project'), []);
    assert.deepEqual(store.getSkillCatalog('/work/project/'), second);
    store.setSkillCatalog('/work/empty', []);
    assert.deepEqual(store.getSkillCatalog('/work/empty'), []);
  } finally {
    store.close();
  }
});

test('skill catalogs and empty replacements persist across disk restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-skill-catalog-'));
  const filename = join(directory, 'topics.sqlite');
  const skills = [
    { name: 'second', description: 'Preserve catalog order' },
    { name: 'first', description: 'Unicode description: café' },
  ];
  const otherSkills = [{ name: 'other', description: 'Isolated instance' }];
  try {
    const first = new Store(filename);
    try {
      first.setSkillCatalog('/work/project', skills);
      first.setSkillCatalog('/work/other', otherSkills);
    } finally {
      first.close();
    }
    const second = new Store(filename);
    try {
      assert.deepEqual(second.getSkillCatalog('/work/project'), skills);
      assert.deepEqual(second.getSkillCatalog('/work/other'), otherSkills);
      assert.equal(second.getSkillCatalog('/work/missing'), undefined);
      second.setSkillCatalog('/work/project', []);
    } finally {
      second.close();
    }
    const third = new Store(filename);
    try {
      assert.deepEqual(third.getSkillCatalog('/work/project'), []);
      assert.deepEqual(third.getSkillCatalog('/work/other'), otherSkills);
      assert.equal(third.getSkillCatalog('/work/missing'), undefined);
    } finally {
      third.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
