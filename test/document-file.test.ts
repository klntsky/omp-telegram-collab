import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a real partial staging write failure preserves the original and removes staging files', {skip:process.platform !== 'linux'}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'document-file-'));
  const path = join(directory, 'existing.txt');
  const original = Buffer.from('Original document bytes must survive failure.\n');
  writeFileSync(path, original);
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { saveDocument } from ${JSON.stringify(new URL('../src/bot/document-file.ts', import.meta.url).href)};
      // Load all modules before lowering the limit so transpiler cache writes are unaffected.
      process.on('SIGXFSZ', () => {});
      execFileSync('prlimit', ['--pid', String(process.pid), '--fsize=1024:1024']);
      // Linux writes the first 1024 bytes, then rejects the remaining bytes with EFBIG.
      assert.throws(() => saveDocument(process.argv[1], Buffer.alloc(2048, 0x61)), error => {
        assert.equal(error.code, 'EFBIG');
        assert.equal(error.syscall, 'write');
        process.stdout.write(JSON.stringify({code:error.code, syscall:error.syscall}));
        return true;
      });
    `, path], {encoding:'utf8', timeout:30_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {code:'EFBIG', syscall:'write'});
    assert.deepEqual(readFileSync(path), original);
    assert.deepEqual(readdirSync(directory), ['existing.txt']);
  } finally {
    rmSync(directory, {recursive:true, force:true});
  }
});
