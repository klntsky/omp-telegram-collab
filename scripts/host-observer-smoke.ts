import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from '@lydell/node-pty';
import { startLocalRelay } from './local-relay.js';
import { createConversation } from '../src/runtime/conversation.js';
import { createOwnership } from '../src/runtime/ownership.js';
import { procIdentity } from '../src/runtime/process.js';
import { writeBinding } from '../src/runtime/files.js';
import type { AppConfig, TopicSession } from '../shared/contracts.js';
import { ConversationConflictError, type ManagedHost } from '../src/runtime/types.js';

type Snapshot = { sessionId: string; sessionFile: string; cwd: string; pid: number; launchId: string;
  continuationOf?: string;
  candidate?: { sessionId: string; sessionFile: string; cwd: string; sequence: number; reason: string; previousSessionFile: string } };
type Host = { terminal: pty.IPty; slot: string; directory: string; output: string; exited: boolean; exit: Promise<void> };

export async function verifyNativeObserver(executable = process.env.OMP_EXECUTABLE ?? 'omp'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'omp-native-observer-'));
  const relay = await startLocalRelay();
  const hosts: Host[] = [];
  const config: AppConfig = { bots: [], instances: [{ id: 1, defaultDir: directory, chats: [] }], configPath: join(directory, 'bot.yml'),
    publicUrl: '', host: 'localhost', port: 0, dataDir: directory, omp: { executable, args: [], maxSessions: 2, startupTimeoutMs: 60000 } };
  const ownership = createOwnership({ config, closed: false });
  const managed = new Map<string, ManagedHost | null>();
  const conversation = createConversation({ config, managed, acquire: ownership.acquire, lifecycle: ownership.lifecycle,
    list: async () => registry(), assertActive: () => { if (hosts.some(host => host.exited)) throw new Error('Native observer host exited'); } });
  const home = join(directory, 'home');
  const agent = join(home, '.omp', 'agent');
  await mkdir(agent, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PI_CODING_AGENT_DIR: agent,
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_STATE_HOME: join(directory, 'state'),
    XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), TERM: 'xterm-256color' };
  const initial = join(directory, 'initial.jsonl');
  const initialId = randomUUID();
  const seedEntry = '01234567';
  await writeFile(initial, [
    { type: 'session', version: 3, id: initialId, timestamp: new Date().toISOString(), cwd: directory },
    { type: 'message', id: seedEntry, parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Native branch fixture', timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const overlay = join(directory, 'runtime.json');
  await writeFile(overlay, JSON.stringify({ collab: { autoStart: 'control', relayUrl: relay.url },
    startup: { checkUpdate: false, setupWizard: false } }));
  const commands = join(directory, 'commands.mjs');
  const failed = join(directory, 'failed.json');
  await writeFile(commands, `import {writeFileSync} from 'node:fs';
export default pi=>{
  pi.registerCommand('observer-new',{handler:async(_,ctx)=>{await ctx.newSession();}});
  pi.registerCommand('observer-branch',{handler:async(_,ctx)=>{await ctx.branch(${JSON.stringify(seedEntry)});}});
  pi.registerCommand('observer-resume',{handler:async(_,ctx)=>{await ctx.switchSession(${JSON.stringify(initial)});}});
  pi.registerCommand('observer-fail',{handler:async(_,ctx)=>{try{await ctx.switchSession(${JSON.stringify(directory)})}catch(error){writeFileSync(${JSON.stringify(failed)},JSON.stringify({error:String(error),sessionId:ctx.sessionManager.getSessionId()}))}}});
  pi.registerCommand('observer-write',{handler:async(name,ctx)=>{
    try {
      await pi.setSessionName(name);
      writeFileSync(process.env.OMP_TELEGRAM_SESSION_DIR+'/write.json',JSON.stringify({sessionId:ctx.sessionManager.getSessionId(),header:ctx.sessionManager.getHeader()}));
    } catch(error) {
      writeFileSync(process.env.OMP_TELEGRAM_SESSION_DIR+'/write.json',JSON.stringify({error:String(error)}));
    }
  }});
};`);
  async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const result = await read();
      if (result !== undefined) return result;
      const dead = hosts.find(host => host.exited);
      if (dead) throw new Error(`${label}: native host exited: ${dead.output}`);
      await delay(30);
    }
    throw new Error(`${label}: ${hosts.map(host => host.output).join('\n')}`);
  }
  async function json(filename: string): Promise<any> {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async function start(history: string): Promise<Host> {
    const launchId = randomUUID();
    const launch = join(directory, 'sessions', launchId, 'launches', launchId);
    await mkdir(launch, { recursive: true, mode: 0o700 });
    const terminal = pty.spawn(executable, ['--cwd', directory, '--session-dir', directory, '--resume', history,
      '--config', overlay, '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title',
      '--extension', fileURLToPath(new URL('../src/host-lifecycle.mjs', import.meta.url)), '--extension', commands],
    { cwd: directory, env: { ...env, OMP_TELEGRAM_SESSION_DIR: launch, OMP_TELEGRAM_LAUNCH_ID: launchId },
      name: 'xterm-256color', cols: 100, rows: 30 });
    const exit = Promise.withResolvers<void>();
    const host: Host = { terminal, slot: launchId, directory: launch, output: '', exited: false, exit: exit.promise };
    hosts.push(host);
    terminal.onData(part => { host.output = (host.output + part).slice(-12000); });
    terminal.onExit(() => { host.exited = true; exit.resolve(); });
    await waitFor(() => json(join(launch, 'lifecycle.json')), 'Lifecycle did not publish');
    return host;
  }
  async function status(host: Host, extra = {}): Promise<Snapshot> {
    const descriptor = await json(join(host.directory, 'lifecycle.json'));
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<Snapshot>();
    const socket = createConnection(descriptor.socketPath);
    socket.setTimeout(2000, () => socket.destroy(new Error('Lifecycle status timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'status', requestId, deadline: Date.now() + 2000, ...extra })}\n`));
    let input = '';
    socket.on('data', part => { input += part; });
    socket.once('end', () => {
      try {
        const result = JSON.parse(input);
        assert.equal(result.requestId, requestId);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
    try { return await promise; } finally { socket.destroy(); }
  }
  const execute = promisify(execFile);
  async function registry(): Promise<any[]> {
    const { stdout } = await execute(executable, ['collab', 'list', '--json'], { env, cwd: directory, timeout: 5000 });
    return JSON.parse(stdout).hosts;
  }
  async function follow(host: Host, native: Snapshot, instanceId: string): Promise<TopicSession> {
    const root = join(directory, 'sessions', host.slot);
    const identity = await procIdentity(native.pid);
    assert.ok(identity);
    await writeBinding(root, { version: 1, sessionId: native.sessionId, sessionFile: native.sessionFile, cwd: native.cwd });
    await writeFile(join(root, 'active-launch.json'), JSON.stringify({ version: 1, id: host.slot, sessionId: native.sessionId, cwd: native.cwd,
      host: { pid: native.pid, start: identity.start, instanceId } }));
    return { id: host.slot, botId: 1, chatId: -100, threadId: 2, instanceId: 1, cwd: directory,
      name: 'Observer', status: 'open', createdAt: 0, runtime: { kind: 'managed' } };
  }
  let failure: unknown;
  try {
    const host = await start(initial);
    const before = await status(host);
    assert.equal(before.sessionId, initialId);
    const original = await waitFor(async () => (await registry()).find(item => item.pid === before.pid), 'Initial registry publication');
    const topic = await follow(host, before, original.instanceId);
    host.terminal.write('/observer-branch\r');
    const branched = await waitFor(async () => {
      const value = await status(host);
      return value.sessionId !== initialId && value.candidate?.reason === 'branch' ? value : undefined;
    }, 'Native branch observation');
    await waitFor(async () => (await registry()).find(item => item.pid === before.pid && item.sessionId === branched.sessionId), 'Branch settlement');
    await conversation.refresh(topic);
    assert.equal((await json(join(directory, 'sessions', topic.id, 'binding.json'))).sessionId, branched.sessionId);
    host.terminal.write('\x15/observer-resume\r');
    await waitFor(async () => (await registry()).find(item => item.pid === before.pid && item.sessionId === initialId), 'Branch source resume');
    await conversation.refresh(topic);
    host.terminal.write('/observer-new\r');
    let changed = await waitFor(async () => { const value = await status(host); return value.sessionId !== before.sessionId && value.candidate?.sessionId === value.sessionId ? value : undefined; }, 'New session observation');
    assert.equal(changed.candidate?.reason, 'new');
    assert.equal(changed.candidate?.previousSessionFile, initial);
    assert.equal(changed.candidate?.sessionId, changed.sessionId);
    assert.equal(changed.candidate?.sessionFile, changed.sessionFile);
    assert.equal(changed.launchId, before.launchId);
    const settled = await waitFor(async () => (await registry()).find(item => item.pid === before.pid && item.sessionId === changed.sessionId), 'Settled registry publication');
    assert.equal(settled.instanceId, original.instanceId);
    const intermediate = changed;
    host.terminal.write('/observer-new\r');
    changed = await waitFor(async () => {
      const value = await status(host);
      return value.sessionId !== intermediate.sessionId && value.candidate?.sessionId === value.sessionId ? value : undefined;
    }, 'Consecutive native transition');
    await waitFor(async () => (await registry()).find(item => item.pid === before.pid && item.sessionId === changed.sessionId), 'Consecutive transition settlement');
    await conversation.refresh(topic);
    assert.equal((await json(join(directory, 'sessions', topic.id, 'binding.json'))).sessionId, changed.sessionId);
    host.terminal.write('/observer-fail\r');
    const failure = await waitFor(() => json(failed), 'Failed resume observation');
    assert.equal(failure.error, 'Error: Directories cannot be read like files');
    const rollback = await status(host);
    assert.equal(rollback.sessionId, changed.sessionId);
    assert.equal(rollback.candidate?.sequence, changed.candidate?.sequence);
    await conversation.refresh(topic);
    assert.equal((await json(join(directory, 'sessions', topic.id, 'binding.json'))).sessionId, changed.sessionId);
    host.terminal.write('/observer-resume\r');
    const resumed = await waitFor(async () => { const value = await status(host); return value.sessionId === initialId && value.candidate?.sessionId === initialId ? value : undefined; }, 'Resume observation');
    assert.equal(resumed.candidate?.reason, 'resume');
    assert.equal(resumed.candidate?.previousSessionFile, changed.sessionFile);
    await waitFor(async () => (await registry()).find(item => item.pid === before.pid && item.sessionId === initialId), 'Resumed registry publication');
    await conversation.refresh(topic);
    assert.equal((await json(join(directory, 'sessions', topic.id, 'binding.json'))).sessionId, initialId);
    host.terminal.write('/observer-write incumbent\r');
    const incumbentWrite = await waitFor(() => json(join(host.directory, 'write.json')), 'Incumbent native writer');
    assert.equal(incumbentWrite.error, undefined);
    assert.equal(incumbentWrite.sessionId, initialId);
    const contender = await start(initial);
    const other = await status(contender);
    assert.equal(other.sessionId, initialId);
    contender.terminal.write('/observer-new\r');
    await waitFor(async () => {
      const value = await status(contender);
      return value.sessionId !== initialId && value.candidate?.sessionId === value.sessionId ? value : undefined;
    }, 'Contender new session');
    contender.terminal.write('/observer-resume\r');
    const intentional = await waitFor(async () => {
      const value = await status(contender);
      return value.sessionId === initialId && value.candidate?.sessionId === initialId ? value : undefined;
    }, 'Contender intentional resume');
    const competing = await waitFor(async () => { const values = (await registry()).filter(item => item.sessionId === initialId); return values.length === 2 ? values : undefined; }, 'Two open native hosts');
    assert.notEqual(competing[0].instanceId, competing[1].instanceId);
    const contenderTopic = await follow(contender, intentional, competing.find(item => item.pid === intentional.pid).instanceId);
    contender.terminal.write('/observer-write contender\r');
    const contenderWrite = await waitFor(() => json(join(contender.directory, 'write.json')), 'Contending native writer');
    assert.equal(contenderWrite.error, undefined);
    const continued = await waitFor(async () => {
      const value = await status(contender);
      return value.sessionId !== initialId ? value : undefined;
    }, 'Writer continuation observation');
    assert.equal(contenderWrite.sessionId, continued.sessionId);
    assert.notEqual(continued.sessionFile, initial);
    assert.equal(continued.candidate?.sessionId, initialId);
    assert.equal(continued.candidate?.sessionFile, initial);
    assert.notEqual(continued.sessionId, continued.candidate?.sessionId);
    assert.equal(continued.candidate?.sequence, intentional.candidate?.sequence);
    assert.equal(continued.continuationOf, initialId);
    assert.equal(contenderWrite.header.continuationOf, initialId);
    const continuationHeader = (await readFile(continued.sessionFile, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).find(entry => entry.type === 'session');
    assert.equal(continuationHeader.id, continued.sessionId);
    assert.equal(continuationHeader.continuationOf, initialId);
    await assert.rejects(conversation.refresh(contenderTopic), ConversationConflictError);
    assert.equal((await json(join(directory, 'sessions', contenderTopic.id, 'binding.json'))).sessionId, initialId);
    assert.equal((await status(host)).sessionId, initialId);
    assert.equal((await status(host)).pid, before.pid);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const host of hosts) {
      try {
        if (!host.exited) host.terminal.kill();
        const timedOut = Promise.withResolvers<never>();
        const timeout = setTimeout(() => timedOut.reject(new Error(`Native host did not exit: ${host.output}`)), 10000);
        try { await Promise.race([host.exit, timedOut.promise]); } finally { clearTimeout(timeout); }
      } catch (error) { errors.push(error); }
    }
    try { await relay.close(); } catch (error) { errors.push(error); }
    ownership.close();
    if (hosts.every(host => host.exited)) {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Native observer cleanup failed');
  }
}
