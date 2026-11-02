import { appendFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { formatWithOptions } from 'node:util';
import { startLocalRelay } from '../../../scripts/local-relay.js';
import { startFakeLlmProvider, type FakeLlmProvider, type FakeLlmScenario } from './fake-llm-provider.js';

export async function setupOmpEnvironment(t: Pick<TestContext, 'after' | 'signal' | 'diagnostic'>, options: {
  scenarios: readonly FakeLlmScenario[];
}) {
  const root = await mkdtemp(join(tmpdir(), 'omp-telegram-e2e-'));
  const logDirectory = await mkdtemp(join(tmpdir(), 'omp-telegram-e2e-logs-'));
  const tracePath = join(logDirectory, 'events.jsonl');
  await writeFile(tracePath, '', { mode: 0o600 });
  t.diagnostic(`E2E debug artifacts: ${logDirectory}`);
  const secrets = new Set<string>();
  const registerSecret = (value: string) => { if (value) secrets.add(value); };
  for (const key of ['TELEGRAM_TEST_BOT_TOKEN', 'TELEGRAM_TEST_API_HASH', 'TELEGRAM_TEST_SESSION']) {
    if (process.env[key]) registerSecret(process.env[key]!);
  }
  const started = performance.now();
  let sequence = 0;
  function redact(text: string): string {
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]');
  }
  function formatDiagnostic(args: unknown[]): string {
    return redact(formatWithOptions({ depth: null, maxArrayLength: null, maxStringLength: null }, ...args));
  }
  function log(event: string, data: unknown): void {
    const line = JSON.stringify({ sequence: ++sequence, time: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), event, data }, (_key, value: unknown) => {
      if (value instanceof Error) return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, Reflect.get(value, key)]));
      return value;
    });
    appendFileSync(tracePath, `${redact(line)}\n`, { mode: 0o600 });
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
  let relay: { url: string; close(): Promise<void> } | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    log('environment-cleanup-start', {});
    for (const close of [() => provider?.close(), () => relay?.close()]) {
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
        for (const filename of await readdir(directory)) {
          if (filename === 'history.jsonl' || /^terminal\.log(?:\.1)?$/.test(filename)) {
            const destination = join(logDirectory, 'sessions', session);
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await cp(join(directory, filename), join(destination, filename));
          }
        }
      }
    } catch (error) { log('artifact-copy-error', error); errors.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { log('environment-cleanup-error', error); errors.push(error); }
    log('environment-cleanup-end', { errors: errors.length });
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
  const skillDirectory = join(agent, 'skills', 'e2e-review');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: e2e-review\ndescription: Review the E2E task\n---\nPreserve the e2e-skill-loaded marker when reviewing this task.\n');
  provider = await startFakeLlmProvider({ scenarios: options.scenarios, log });
  relay = await startLocalRelay();
  const selectedModel = 'e2e/e2e-model';
  await writeFile(join(agent, 'models.yml'), JSON.stringify({ providers: { e2e: {
    baseUrl: provider.baseUrl,
    api: 'openai-completions',
    apiKey: provider.apiKey,
    models: [{ id: 'e2e-model', name: 'E2E Model', reasoning: false, input: ['text', 'image'], supportsTools: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  } } }), { mode: 0o600 });
  await writeFile(join(agent, 'config.yml'), JSON.stringify({
    startup: { checkUpdate: false, setupWizard: false },
    modelRoles: { default: selectedModel, smol: selectedModel, slow: selectedModel, plan: selectedModel },
  }), { mode: 0o600 });
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    PI_CODING_AGENT_DIR: agent,
    ...xdg,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  };
  const executable = join(root, 'omp');
  const actualOmp = process.env.OMP_EXECUTABLE ?? 'omp';
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const assignments = Object.entries(env).map(([key, value]) => quote(`${key}=${value}`));
  const lifecycleKeys = ['OMP_TELEGRAM_SESSION_DIR', 'OMP_TELEGRAM_DEFAULT_PRESET', 'OMP_TELEGRAM_SUPERVISOR_PID'];
  const forwarded = lifecycleKeys.map(key => `"${key}=\${${key}-}"`);
  await writeFile(executable, `#!/bin/sh\nexec /usr/bin/env -i ${assignments.join(' ')} ${forwarded.join(' ')} /bin/bash -c 'exec -a \"$0\" \"$@\"' ${quote(executable)} ${quote(actualOmp.includes('/') ? resolve(actualOmp) : actualOmp)} \"$@\"\n`, { mode: 0o700 });
  const args = [
    '--no-extensions', '--no-rules', '--no-context-files', '--no-title', '--no-lsp', '--no-pty',
    '--model', selectedModel, '--smol', selectedModel, '--slow', selectedModel,
    '--thinking', 'off', '--tools', 'write', '--approval-mode', 'yolo',
    '--system-prompt', 'Complete the requested task with the provided write tool.',
  ];
  log('environment-ready', { workspace, dataDir, executable, actualOmp, args, environmentKeys: Object.keys(env), providerUrl: provider.baseUrl, relayUrl: relay.url });
  return { workspace, dataDir, executable, args, relayUrl: relay.url, provider, log, step, formatDiagnostic, logDirectory, registerSecret };
}
