import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { privateFile } from './files.js';
import { belongsTo, procIdentity } from './process.js';
import { errno, delay } from './values.js';

export interface LaunchRecord { version: 1; id: string; sessionId: string; cwd: string; resolved?: true; host?: { pid: number; start: string; instanceId: string } }
interface Evidence { pid: number; start: string; child?: { pid: number; start: string; group: number }; childExited?: true; spawnFailed?: true }
async function json<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if (errno(error, 'ENOENT')) return undefined; throw error; }
}
async function durable(dir: string, name: string, value: unknown): Promise<void> {
  const temporary = path.join(dir, `${name}.${randomUUID()}.tmp`);
  await privateFile(temporary, JSON.stringify(value), true);
  await rename(temporary, path.join(dir, name));
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function readLaunch(dir: string): Promise<LaunchRecord | undefined> {
  const value = await json<LaunchRecord>(path.join(dir, 'active-launch.json'));
  if (value && (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.sessionId !== 'string' || typeof value.cwd !== 'string')) throw new Error('Invalid managed OMP launch record');
  return value;
}
export async function activeLaunchDir(dir: string): Promise<string> {
  const launch = await readLaunch(dir);
  return launch ? path.join(dir, 'launches', launch.id) : dir;
}
export async function beginLaunch(dir: string, sessionId: string, cwd: string): Promise<string> {
  if (await launchUnresolved(dir)) throw new Error('OMP launch ownership is unresolved; cannot safely start another process');
  const launch: LaunchRecord = { version: 1, id: randomUUID(), sessionId, cwd };
  const target = path.join(dir, 'launches', launch.id);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const parent = await open(path.dirname(target), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  await durable(dir, 'active-launch.json', launch);
  return target;
}
export async function cancelUnspawnedLaunch(dir: string): Promise<void> {
  const launch = await readLaunch(dir);
  if (launch) await durable(dir, 'active-launch.json', { ...launch, resolved: true });
}
export async function recordLaunchHost(dir: string, host: { pid: number; instanceId: string }): Promise<void> {
  const launch = await readLaunch(dir);
  const identity = await procIdentity(host.pid);
  if (launch) {
    const evidencePath = path.join(await activeLaunchDir(dir), 'supervisor.json');
    let evidence = await json<Evidence>(evidencePath);
    const deadline = Date.now() + 1000;
    while (!evidence?.child && !evidence?.spawnFailed && !evidence?.childExited && Date.now() < deadline) {
      if (evidence && !await alive(evidence.pid, evidence.start)) break;
      await delay(10);
      evidence = await json<Evidence>(evidencePath);
    }
    if (!evidence?.child || !await belongsTo(host.pid, evidence.child.pid) ||
        !await alive(evidence.child.pid, evidence.child.start)) throw new Error('Managed OMP launch host identity changed');
  }
  if (launch && identity) await durable(dir, 'active-launch.json', { ...launch, host: { pid: host.pid, start: identity.start, instanceId: host.instanceId } });
}
async function alive(pid: number, start: string): Promise<boolean> {
  const identity = await procIdentity(pid);
  return !!identity && identity.start === start && identity.state !== 'Z' && identity.state !== 'X';
}
export async function settleLaunch(dir: string): Promise<boolean> {
  const launch = await readLaunch(dir);
  if (!launch || launch.resolved) return true;
  if (launch.host && await alive(launch.host.pid, launch.host.start)) return false;
  const evidence = await json<Evidence>(path.join(await activeLaunchDir(dir), 'supervisor.json'));
  if (!evidence || !Number.isSafeInteger(evidence.pid) || typeof evidence.start !== 'string') return false;
  if (await alive(evidence.pid, evidence.start)) return false;
  if (!evidence.spawnFailed && !evidence.child) return false;
  if (evidence.child) {
    if (await alive(evidence.child.pid, evidence.child.start)) return false;
    // A vanished supervisor does not prove that its terminal children exited.
    if (!evidence.childExited) return false;
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const identity = await procIdentity(Number(entry));
      if (identity?.group === evidence.child.group && identity.state !== 'Z' && identity.state !== 'X') return false;
    }
  }
  await durable(dir, 'active-launch.json', { ...launch, resolved: true });
  return true;
}
export async function launchUnresolved(dir: string): Promise<boolean> { return !await settleLaunch(dir); }
export async function launchFailure(dir: string, error: unknown): Promise<void> {
  if (await readLaunch(dir)) await durable(await activeLaunchDir(dir), 'cleanup-error.json', { error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
}
export async function cleanupLaunch(dir: string): Promise<void> {
  if (!await settleLaunch(dir)) throw new Error('OMP launch ownership is unresolved; cleanup cannot prove that no process survived');
}
export async function killLaunch(dir: string): Promise<void> {
  if (!await readLaunch(dir) || await settleLaunch(dir)) return;
  try {
    const evidence = await json<Evidence>(path.join(await activeLaunchDir(dir), 'supervisor.json'));
    const launch = await readLaunch(dir);
    if (launch?.host && await alive(launch.host.pid, launch.host.start)) {
      if (launch.host.pid <= 1 || launch.host.pid === process.pid) throw new Error('Invalid managed OMP launch host identity');
      try { process.kill(launch.host.pid, 'SIGKILL'); }
      catch (error) { if (!errno(error, 'ESRCH')) throw error; }
    }
    if (evidence?.child && await alive(evidence.child.pid, evidence.child.start)) {
      if (evidence.child.pid <= 1 || evidence.child.pid === process.pid) throw new Error('Invalid managed OMP launch child identity');
      try { process.kill(evidence.child.pid, 'SIGKILL'); }
      catch (error) { if (!errno(error, 'ESRCH')) throw error; }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await settleLaunch(dir)) return;
      await delay(100);
    }
    await cleanupLaunch(dir);
  } catch (error) {
    try { await launchFailure(dir, error); } catch (persistError) {
      if (error instanceof Error) Object.defineProperty(error, 'persistenceError', { value: persistError, configurable: true });
    }
    throw error;
  }
}
