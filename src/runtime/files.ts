import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readHistoryHeader } from '../history-watch.js';
import { type DurableBinding } from './types.js';
import { errno, record } from './values.js';

export function hasRemovedWorktree(binding: unknown): boolean {
  if (!record(binding) || binding.removedWorktree === undefined) return false;
  if (binding.removedWorktree !== true) throw new Error('Invalid removed worktree binding metadata');
  return true;
}
export async function privateFile(file: string, contents: string, exclusive = false): Promise<void> {
  const handle = await open(file, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeBinding(dir: string, binding: DurableBinding): Promise<void> {
  const temporary = path.join(dir, `binding.${randomUUID()}.tmp`);
  try {
    await privateFile(temporary, `${JSON.stringify(binding)}\n`, true);
    await rename(temporary, path.join(dir, 'binding.json'));
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (!errno(error, 'ENOENT')) throw error;
    });
  }
}

export async function readHeader(file: string): Promise<{ id: string; cwd: string }> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed history must be a regular file');
  const handle = await open(file, 'r');
  try {
    return await readHistoryHeader(handle);
  } finally {
    await handle.close();
  }
}
