import { OmpProtocolError, OmpCommandError, parseJson, OmpConfigurationError } from './errors.js';

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import { findInstance } from '../config.js';
import { formatUsage } from '../usage.js';
import { PRESET_MODEL_ARGS, ompArguments } from './arguments.js';
import { record } from './values.js';
interface SettingsDependencies {
  assertActive(): void;
  readonly config: AppConfig;
  instanceDirectory(instanceId: number): string;
}

// This owner keeps the complete settings transaction and its cleanup together.
export interface RuntimeSettings {
  providerUsage(instanceId: number): Promise<{ heading: string; table: string }[]>;
  availableModelPresets(instanceId: number, discoveryCwd?: string): Promise<string[]>;
  modelPresetDetails(instanceId: number, name: string, discoveryCwd?: string): Promise<{modelRoles: Record<string, string>; defaultThinkingLevel?: string}>;
  presetLaunch(session: TopicSession): Promise<{ overlay: Record<string, unknown>; args: string[]; preset?: string }>;
}

export function createSettings(deps: SettingsDependencies): RuntimeSettings {

  async function nativeSetting(instancePath: string, key: string): Promise<unknown> {
    deps.assertActive();
    const args: string[] = [];
    const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
    for (const arg of ompArguments(deps.config.omp.args)) {
      if (arg.flag === '--alias') throw new OmpConfigurationError('OMP --alias conflicts with native model preset settings discovery', 'OMP model preset settings');
      if (arg.flag !== '--profile' && arg.flag !== '--config') continue;
      if (arg.value === undefined || !arg.value) throw new OmpConfigurationError(`OMP ${arg.flag} requires a value for model preset settings discovery`, 'OMP model preset settings');
      if (arg.flag === '--profile') args.push(...arg.args);
      else configFiles.push(arg.value);
    }
    args.push('config', 'get', key, '--json');
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile(deps.config.omp.executable, args, {
      cwd: instancePath,
      env: { ...process.env, ...(configFiles.length ? { PI_CONFIG_FILES: configFiles.join(path.delimiter) } : {}) },
      timeout: deps.config.omp.startupTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => error ? reject(new OmpCommandError('Read OMP settings or usage', `cwd ${instancePath}`, error, error.code, error.signal)) : resolve(stdout));
    const output = await promise;

    const result = parseJson(output, 'Read OMP settings', 'OMP settings response');

    if (!record(result) || result.key !== key || !Object.hasOwn(result, 'value')) {
      throw new OmpProtocolError('Read model preset settings', 'OMP native settings', `OMP config get ${key} returned an invalid settings response`);
    }
    return result.value;
  }

  async function providerUsage(instanceId: number): Promise<{ heading: string; table: string }[]> {
    deps.assertActive();
    const instancePath = deps.instanceDirectory(instanceId);
    const args: string[] = [];
    const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
    for (const arg of ompArguments(deps.config.omp.args)) {
      if (arg.flag === '--profile') args.push(...arg.args);
      if (arg.flag === '--config' && arg.value) configFiles.push(arg.value);
    }
    args.push('usage', '--json');
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile(deps.config.omp.executable, args, {
      cwd: instancePath,
      env: { ...process.env, ...(configFiles.length ? { PI_CONFIG_FILES: configFiles.join(path.delimiter) } : {}) },
      timeout: deps.config.omp.startupTimeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => error ? reject(new OmpCommandError('Read OMP settings or usage', `cwd ${instancePath}`, error, error.code, error.signal)) : resolve(stdout));
    const output = await promise;
    return formatUsage(parseJson(output, 'Read OMP settings', 'OMP settings response'));
  }

  async function availableModelPresets(instanceId: number, discoveryCwd?: string): Promise<string[]> {
    const presets = await nativeSetting(discoveryCwd ?? deps.instanceDirectory(instanceId), 'modelPresets');
    if (!record(presets)) throw new OmpProtocolError('Read model preset settings', 'OMP native settings', 'OMP config get modelPresets returned an invalid preset mapping');
    return Object.keys(presets).filter(name => presets[name] !== null && presets[name] !== undefined).sort((a, b) => a.localeCompare(b));
  }

  async function modelPresetDetails(instanceId: number, name: string, discoveryCwd?: string): Promise<{modelRoles: Record<string, string>; defaultThinkingLevel?: string}> {
    const presets = await nativeSetting(discoveryCwd ?? deps.instanceDirectory(instanceId), 'modelPresets');
    if (!record(presets)) throw new OmpProtocolError('Read model preset settings', 'OMP native settings', 'OMP config get modelPresets returned an invalid preset mapping');
    const preset = Object.hasOwn(presets, name) ? presets[name] : undefined;
    if (preset === undefined || preset === null) throw new OmpConfigurationError(`Unknown model preset: ${name}`, 'OMP model preset settings');
    if (!record(preset) || !record(preset.modelRoles)) throw new OmpConfigurationError(`Invalid model preset "${name}": modelRoles must be a mapping`, 'OMP model preset settings');
    const roles: Record<string, string> = {};
    for (const [role, selector] of Object.entries(preset.modelRoles)) {
      if (typeof selector !== 'string' || !selector.trim()) throw new OmpConfigurationError(`Invalid model preset "${name}": role "${role}" is not a model selector`, 'OMP model preset settings');
      roles[role] = selector;
    }
    if (preset.defaultThinkingLevel !== undefined &&
        (typeof preset.defaultThinkingLevel !== 'string' || !preset.defaultThinkingLevel.trim()))
      throw new OmpConfigurationError(`Invalid model preset "${name}": defaultThinkingLevel is not a thinking level`, 'OMP model preset settings');
    return {modelRoles: roles, ...(preset.defaultThinkingLevel === undefined ? {} : {defaultThinkingLevel: preset.defaultThinkingLevel})};
  }

  async function presetLaunch(session: TopicSession): Promise<{ overlay: Record<string, unknown>; args: string[]; preset?: string }> {
    const assigned = findInstance(deps.config, session.botId, session.chatId);
    if (assigned && assigned.instance.id !== session.instanceId) throw new OmpConfigurationError('Managed session forum assignment changed', 'OMP model preset settings');
    const name = assigned?.instance.chats.find(chat => chat.botId === session.botId && chat.chatId === session.chatId)?.default_model_preset;
    if (name === undefined) return { overlay: {}, args: deps.config.omp.args };
    const presets = await nativeSetting(session.cwd, 'modelPresets');
    if (!record(presets)) throw new OmpProtocolError('Read model preset settings', 'OMP native settings', 'OMP config get modelPresets returned an invalid preset mapping');
    const preset = Object.hasOwn(presets, name) ? presets[name] : undefined;
    if (preset === undefined || preset === null) {
      const names = Object.keys(presets).filter(key => presets[key] !== null && presets[key] !== undefined).sort((a, b) => a.localeCompare(b));
      throw new OmpConfigurationError(`Unknown model preset: ${name}. Available presets: ${names.join(', ') || '(none)'}`, 'OMP model preset settings');
    }
    if (!record(preset) || !record(preset.modelRoles)) throw new OmpConfigurationError(`Invalid model preset "${name}": modelRoles must be a mapping`, 'OMP model preset settings');
    for (const [role, selector] of Object.entries(preset.modelRoles)) {
      if (typeof selector !== 'string' || !selector.trim()) throw new OmpConfigurationError(`Invalid model preset "${name}": role "${role}" is not a model selector`, 'OMP model preset settings');
    }
    const defaultThinking = await nativeSetting(session.cwd, 'defaultThinkingLevel');
    const currentRoles = await nativeSetting(session.cwd, 'modelRoles');
    if (!record(currentRoles)) throw new OmpProtocolError('Read model preset settings', 'OMP native settings', 'OMP config get modelRoles returned an invalid role mapping');
    const modelRoles = Object.fromEntries([
      ...Object.keys(currentRoles).map(role => [role, null]),
      ...Object.entries(preset.modelRoles),
    ]);
    const args = ompArguments(deps.config.omp.args).filter(arg => !Object.hasOwn(PRESET_MODEL_ARGS, arg.flag)).flatMap(arg => arg.args);
    if (args.includes('--')) throw new OmpConfigurationError('OMP -- conflicts with managed model preset launch arguments', 'OMP model preset settings');
    return { overlay: { modelRoles, defaultThinkingLevel: defaultThinking }, args, preset: name };
  }

  return { providerUsage, availableModelPresets, modelPresetDetails, presetLaunch };
}

