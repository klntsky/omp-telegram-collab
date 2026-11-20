import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { startFakeLlmProvider, type FakeLlmProvider, type FakeLlmScenario } from './fake-llm-provider.js';
import { readSessionHistory } from './model-tasks.js';
import type { TopicSession } from '../../../shared/contracts.js';
import { errorDiagnostic } from '../../../src/logging.js';

export async function setupOmpEnvironment(t: Pick<TestContext, 'after' | 'signal' | 'diagnostic'>, options: {
  scenarios: readonly FakeLlmScenario[];
  tools?: readonly string[];
  compaction?: { enabled: boolean; supersedeReads: boolean; dropUseless: boolean; experimentalContextManagement: boolean };
}) {
  const root = await mkdtemp(join(tmpdir(), 'omp-telegram-e2e-'));
  const logDirectory = await mkdtemp(join(tmpdir(), 'omp-telegram-e2e-logs-'));
  const tracePath = join(logDirectory, 'events.jsonl');
  await writeFile(tracePath, '', { mode: 0o600 });
  t.diagnostic(`E2E debug artifacts: ${logDirectory}`);
  const started = performance.now();
  let sequence = 0;
  let traceWrites = Promise.resolve();
  const traceErrors: unknown[] = [];
  function log(event: string, data: unknown): void {
    const line = JSON.stringify({ sequence: ++sequence, time: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), event, data }, (_key, value: unknown) => {
      if (value instanceof Error) return errorDiagnostic(value);
      return value;
    });
    traceWrites = traceWrites.then(() => appendFile(tracePath, `${line}\n`, { mode: 0o600 })).catch(error => { traceErrors.push(error); });
  }
  async function flushLogs(): Promise<void> {
    await traceWrites;
    if (traceErrors.length === 1) throw traceErrors[0];
    if (traceErrors.length > 1)
      throw new AggregateError(traceErrors, traceErrors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
  async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
    log('step.start', { name });
    try {
      const result = await action();
      log('step.end', { name });
      return result;
    } catch (error) {
      log('step.error', { name, error });
      throw error;
    }
  }
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'application');
  let provider: FakeLlmProvider | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    log('environment-cleanup-start', {});
    for (const close of [() => provider?.close()]) {
      try { await close(); } catch (error) { log('environment-cleanup-error', error); errors.push(error); }
    }
    try {
      const sessionsDir = join(dataDir, 'sessions');
      let sessions: string[] = [];
      try { sessions = await readdir(sessionsDir); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      for (const session of sessions) {
        const directory = join(sessionsDir, session);
        const filenames = await readdir(directory);
        const destination = join(logDirectory, 'sessions', session);
        for (const filename of filenames) {
          if (/^terminal\.log(?:\.1)?$/.test(filename)) {
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await cp(join(directory, filename), join(destination, filename));
          }
        }
        if (filenames.includes('binding.json')) {
          await mkdir(destination, { recursive: true, mode: 0o700 });
          await writeFile(join(destination, 'history.jsonl'), await readSessionHistory(dataDir, session));
        }
      }
    } catch (error) { log('artifact-copy-error', error); errors.push(error); }
    try { await cp(join(root, 'xdg-state', 'omp', 'logs'), join(logDirectory, 'native-logs'), { recursive: true }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { log('artifact-copy-error', error); errors.push(error); }
    }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { log('environment-cleanup-error', error); errors.push(error); }
    log('environment-cleanup-end', { errors: errors.length });
    await traceWrites;
    errors.push(...traceErrors);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  });
  t.signal.throwIfAborted();
  const home = join(root, 'home');
  const agent = join(home, '.omp', 'agent');
  const xdg = Object.fromEntries(['CONFIG', 'DATA', 'STATE', 'CACHE'].map(kind => [`XDG_${kind}_HOME`, join(root, `xdg-${kind.toLowerCase()}`)]));
  for (const directory of [workspace, dataDir, agent, ...Object.values(xdg).map(directory => join(directory, 'omp'))]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const execute = promisify(execFile);
  const git = (cwd: string, ...args: string[]) => step('git', async () => {
    log('git.command', { cwd, args });
    const { stdout, stderr } = await execute('git', args, {
      cwd, timeout: 10000, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdg.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: '1' },
    });
    log('git.result', { cwd, args, stdout, stderr });
    return stdout.trim();
  });
  await git(workspace, 'init', '--initial-branch=main');
  await git(workspace, 'config', 'user.name', 'E2E Fixture');
  await git(workspace, 'config', 'user.email', 'fixture@example.test');
  await git(workspace, 'config', 'commit.gpgsign', 'false');
  await git(workspace, 'config', 'init.defaultBranch', 'main');
  await git(workspace, 'commit', '--allow-empty', '-m', 'Initialize E2E workspace');
  const assertWorktree = (session: TopicSession, branch = `t.me/c/${String(session.chatId).slice(4)}/${session.threadId}`) => step('omp.worktree', async () => {
    assert.ok(session.runtime.kind === 'managed' && session.cwd);
    const cwd = session.cwd;
    assert.equal(session.instanceId, 1);
    assert.ok(cwd.startsWith(`${dirname(workspace)}${sep}`));
    assert.notEqual(cwd, workspace);
    assert.equal(await git(cwd, 'branch', '--show-current'), branch);
  });
  const skillDirectory = join(agent, 'skills', 'e2e-review');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: e2e-review\ndescription: Review the E2E task\n---\nPreserve the e2e-skill-loaded marker when reviewing this task.\n');
  const followupSkillDirectory = join(agent, 'skills', 'e2e-z-followup');
  await mkdir(followupSkillDirectory, { recursive: true });
  await writeFile(join(followupSkillDirectory, 'SKILL.md'), '---\nname: e2e-z-followup\ndescription: Follow up on the E2E task\n---\nPreserve the e2e-followup-loaded marker.\n');
  provider = await startFakeLlmProvider({ scenarios: options.scenarios, log });
  const selectedModel = 'e2e/e2e-model';
  await writeFile(join(agent, 'models.yml'), JSON.stringify({ providers: { e2e: {
    baseUrl: provider.baseUrl,
    api: 'openai-completions',
    apiKey: provider.apiKey,
    models: ['e2e-model', 'e2e-alternate'].map(id => ({ id, name: id, reasoning: false, input: ['text', 'image'], supportsTools: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 })),
  } } }), { mode: 0o600 });
  const agentConfigPath = join(agent, 'config.yml');
  await writeFile(agentConfigPath, JSON.stringify({
    startup: { checkUpdate: false, setupWizard: false },
    // Script only requested turns, not the terminal composer's extra model call.
    // https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/controllers/composer-prediction-controller.ts (ComposerPredictionController.request)
    composer: { predictions: false },
    // Scripted turns exclude OMP's skill-description model calls, not explicit skill invocation.
    // https://github.com/can1357/oh-my-pi/blob/v18.18.6/packages/coding-agent/src/session/settings.ts#L437-L448
    skillful: false,
    modelRoles: { default: selectedModel, smol: selectedModel, slow: selectedModel, plan: selectedModel },
    ...(options.compaction ? { compaction: options.compaction } : {}),
    modelPresets: {
      'e2e-primary': { modelRoles: { default: selectedModel }, defaultThinkingLevel: 'high' },
      'e2e-alternate': { modelRoles: { default: 'e2e/e2e-alternate' }, defaultThinkingLevel: 'high' },
    },
  }), { mode: 0o600 });
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    PI_CODING_AGENT_DIR: agent,
    // host-control validates lifecycle sockets against the parent's temporary directory.
    TMPDIR: tmpdir(),
    ...xdg,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  };
  const executable = join(root, 'omp');
  const actualOmp = process.env.OMP_EXECUTABLE ?? 'omp';
  const launchDirectory = join(logDirectory, 'launches');
  await mkdir(launchDirectory, { mode: 0o700 });
  const launches = async (): Promise<string[][]> => Promise.all(
    (await readdir(launchDirectory)).map(async name =>
      (await readFile(join(launchDirectory, name), 'utf8')).split('\0').slice(0, -1)),
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const assignments = Object.entries(env).map(([key, value]) => quote(`${key}=${value}`));
  const lifecycleKeys = ['OMP_TELEGRAM_SESSION_DIR', 'OMP_TELEGRAM_DEFAULT_PRESET', 'OMP_TELEGRAM_SUPERVISOR_PID'];
  const forwarded = lifecycleKeys.map(key => `"${key}=\${${key}-}"`);
  const launch = `command=$1
shift
args=("$@")
printf '%s\\0' "\${args[@]}" > ${quote(launchDirectory)}/"$$"
headless=false
for value in "\${args[@]}"; do
  if [[ "$value" == "--mode" ]]; then headless=true; fi
done
if [[ "$headless" == false ]]; then
  for index in "\${!args[@]}"; do
    if [[ "\${args[index]}" == "--tools" ]]; then args[index+1]=${(options.tools ?? ['write','ask']).join(',')}; fi
  done
fi
exec -a "$0" "$command" "\${args[@]}"`;
  await writeFile(executable, `#!/bin/sh\nexec /usr/bin/env -i ${assignments.join(' ')} ${forwarded.join(' ')} /bin/bash -c ${quote(launch)} ${quote(executable)} ${quote(actualOmp.includes('/') ? resolve(actualOmp) : actualOmp)} \"$@\"\n`, { mode: 0o700 });
  const listHosts = () => step('omp.hosts', async () => {
    const { stdout } = await execute(executable, ['collab', 'list', '--json'], { cwd: workspace, timeout: 10000 });
    const result = JSON.parse(stdout);
    log('omp.hosts.result', result);
    return z.object({ hosts: z.array(z.object({
      instanceId: z.string(), sessionId: z.string(), cwd: z.string(), pid: z.number(), relayConnected: z.boolean(),
    })) }).parse(result).hosts;
  });
  const args = [
    '--no-extensions', '--no-rules', '--no-context-files', '--no-title', '--no-lsp', '--no-pty',
    '--model', selectedModel, '--smol', selectedModel, '--slow', selectedModel,
    '--thinking', 'off', '--tools', 'write', '--approval-mode', 'yolo',
    '--system-prompt', 'Complete the requested task with the available tools.',
  ];
  log('environment-ready', { workspace, dataDir, executable, actualOmp, args, environmentKeys: Object.keys(env), providerUrl: provider.baseUrl });
  return { workspace, dataDir, executable, agentConfigPath, args, provider, log, step, git, listHosts, assertWorktree, launches, logDirectory, flushLogs };
}
