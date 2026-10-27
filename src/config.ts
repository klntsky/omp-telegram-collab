import { resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig, BotConfig } from '../shared/contracts.js';

export class ConfigError extends Error {
  constructor(readonly keys: readonly string[], detail: string) {
    super(`Configuration error in ${keys.join(', ')}: ${detail}`);
    this.name = 'ConfigError';
  }
}

const tokenPattern = /^\d+:[A-Za-z0-9_-]+$/;
const usernameSchema = z.string().regex(/^@?[A-Za-z0-9_]{1,32}$/).regex(/[A-Za-z]/)
  .transform(username => username.replace(/^@/, '').toLowerCase());
const namesSchema = z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).transform(name => name.toUpperCase())).min(1)
  .refine(names => new Set(names).size === names.length);
const ownersSchema = z.array(usernameSchema).min(1);
const shortNameSchema = z.string().regex(/^[A-Za-z0-9_]+$/);
const publicUrlSchema = z.string().url().pipe(z.string().refine(value => {
  if (!/^https:\/\/[^/?#\\@]+\/?$/i.test(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
})).transform(value => new URL(value).origin);
const relayUrlSchema = z.string().url().pipe(z.string().refine(value => {
  const url = new URL(value);
  return (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !value.includes('#');
}));
const integerSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe());
const portSchema = integerSchema.pipe(z.number().min(0).max(65535));
const positiveIntegerSchema = integerSchema.pipe(z.number().positive());

function parseEnvironment<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, detail: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConfigError([key], detail);
  return result.data;
}

export function getBotToken(bot: BotConfig, environment: NodeJS.ProcessEnv = process.env): string {
  const token = environment[bot.tokenEnv];
  if (!token || !tokenPattern.test(token)) throw new ConfigError([bot.tokenEnv], 'Set a valid Telegram bot token.');
  return token;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AppConfig {
  const optional = (key: string): string | undefined => environment[key]?.trim() || undefined;
  const botNames = optional('TELEGRAM_BOT_NAMES');
  const prefixes = botNames === undefined ? ['TELEGRAM'] : parseEnvironment(
    'TELEGRAM_BOT_NAMES', namesSchema,
    botNames.split(',').map(name => name.trim()),
    'Use comma-separated ASCII identifiers starting with a letter, without duplicate names.',
  ).map(name => `TELEGRAM_${name}`);
  const requiredKeys = [...prefixes.flatMap(prefix => [`${prefix}_BOT_TOKEN`, `${prefix}_OWNER_USERNAMES`]), 'PUBLIC_URL'];
  const missingKeys = requiredKeys.filter(key => optional(key) === undefined);
  if (missingKeys.length) throw new ConfigError(missingKeys, 'Set these required environment variables before starting the service.');

  const tokens = new Map<string, string>();
  const bots = prefixes.map(prefix => {
    const tokenEnv = `${prefix}_BOT_TOKEN`;
    const ownersKey = `${prefix}_OWNER_USERNAMES`;
    const shortNameKey = `${prefix}_MINI_APP_SHORT_NAME`;
    const ownerUsernames = parseEnvironment(
      ownersKey, ownersSchema,
      optional(ownersKey)!.split(',').map(username => username.trim()),
      'Use comma-separated Telegram usernames, optionally prefixed with @; each must contain a letter and use at most 32 ASCII letters, digits, or underscores.',
    );
    const bot: BotConfig = {
      tokenEnv,
      ownerUsernames: [...new Set(ownerUsernames)],
      miniAppShortName: parseEnvironment(shortNameKey, shortNameSchema, optional(shortNameKey) ?? 'collab', 'Use only ASCII letters, digits, or underscores.'),
    };
    const token = getBotToken(bot, environment);
    const duplicateKey = tokens.get(token);
    if (duplicateKey) throw new ConfigError([duplicateKey, tokenEnv], 'Configure a distinct Telegram bot token for each bot.');
    tokens.set(token, tokenEnv);
    return bot;
  });
  const args: { index: bigint; value: string }[] = [];
  for (const key of Object.keys(environment)) {
    if (key !== 'OMP_ARG' && !key.startsWith('OMP_ARG_')) continue;
    const suffix = key.slice('OMP_ARG_'.length);
    if (!/^[1-9]\d*$/.test(suffix)) throw new ConfigError([key], 'Name literal OMP arguments OMP_ARG_1, OMP_ARG_2, and so on, without leading zeroes.');
    const value = environment[key];
    if (value !== undefined && value !== '') args.push({ index: BigInt(suffix), value });
  }
  args.sort((left, right) => left.index < right.index ? -1 : left.index > right.index ? 1 : 0);
  const relayUrl = optional('OMP_RELAY_URL');
  return {
    bots,
    publicUrl: parseEnvironment('PUBLIC_URL', publicUrlSchema, optional('PUBLIC_URL'), 'Set an HTTPS origin with no credentials, path, query, or fragment.'),
    host: optional('HOST') ?? '127.0.0.1',
    port: parseEnvironment('PORT', portSchema, optional('PORT') ?? '3000', 'Set an integer from 0 through 65535.'),
    dataDir: resolve(cwd, optional('DATA_DIR') ?? '.omp-telegram'),
    omp: {
      executable: optional('OMP_EXECUTABLE') ?? 'omp',
      cwd: resolve(cwd, optional('OMP_CWD') ?? '.'),
      args: args.map(argument => argument.value),
      maxSessions: parseEnvironment('OMP_MAX_SESSIONS', positiveIntegerSchema, optional('OMP_MAX_SESSIONS') ?? '8', 'Set a positive safe integer.'),
      startupTimeoutMs: parseEnvironment('OMP_STARTUP_TIMEOUT_MS', positiveIntegerSchema, optional('OMP_STARTUP_TIMEOUT_MS') ?? '60000', 'Set a positive safe integer.'),
      ...(relayUrl === undefined ? {} : { relayUrl: parseEnvironment('OMP_RELAY_URL', relayUrlSchema, relayUrl, 'Set a wss:// relay URL, or ws:// for localhost, without credentials or a fragment.') }),
    },
  };
}
