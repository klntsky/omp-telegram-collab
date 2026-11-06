import { readFile } from 'node:fs/promises';
import { errno } from './values.js';
export async function procIdentity(pid: number): Promise<{ parent: number; group: number; start: string; state: string } | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]!, state: fields[0]! };
  } catch (error) {
    if (errno(error, 'ENOENT') || errno(error, 'ESRCH')) return null;
    throw error;
  }
}

export async function belongsTo(pid: number, parent: number): Promise<boolean> {
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (pid === parent) return true;
    const info = await procIdentity(pid);
    if (!info || info.parent === pid) return false;
    pid = info.parent;
  }
  return false;
}
