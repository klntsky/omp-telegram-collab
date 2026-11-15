export class OmpNotRepositoryError extends Error {
  constructor(cwd: string, cause: Error) { super(`Inspect Git repository in ${cwd}: ${cause.message}`, { cause }); this.name = 'OmpNotRepositoryError'; }
}

export function parseObject(text: string, operation: string, context: string): Record<string, unknown> {
  const value = parseJson(text, operation, context);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OmpProtocolError(operation, context, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

export class OmpProcessError extends Error {
  constructor(operation: string, context: string, diagnostic: string, options?: ErrorOptions) { super(`${operation} (${context}): ${diagnostic}`, options); this.name = 'OmpProcessError'; }
}

export class OmpRuntimeOwnershipError extends Error {
  constructor(directory: string, cause: Error) { super(`Acquire exclusive OMP runtime ownership in ${directory}: ${cause.message}`, { cause }); this.name = 'OmpRuntimeOwnershipError'; }
}

export class OmpServiceTerminatedError extends Error {
  constructor() { super('The service got terminated, only admin can resume it (remove terminated: true from the config)'); this.name = 'OmpServiceTerminatedError'; }
}

export async function settleOperations(operations: Iterable<Promise<unknown> | undefined>, operation: string): Promise<void> {
  for (const result of await Promise.allSettled(operations)) {
    if (result.status === 'rejected') console.error(`${operation} failed:`, result.reason);
  }
}

export class OmpSystemError extends Error {
  constructor(readonly code: string, operation: string, cause: Error) {
    super(`${operation}: ${cause.message}`, { cause });
    this.name = 'OmpSystemError';
  }
}

export function systemError(error: unknown, operation: string): unknown {
  if (error instanceof OmpSystemError) return error;
  // Node errno is recognized only at the OS integration boundary.
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
    return new OmpSystemError(error.code, operation, error);
  }
  return error;
}

export class OmpSessionUnavailableError extends Error {
  constructor(message: string, context: string) { super(`${context}: ${message}`); this.name = 'OmpSessionUnavailableError'; }
}

export class OmpConfigurationError extends Error {
  constructor(message: string, context: string) { super(`${context}: ${message}`); this.name = 'OmpConfigurationError'; }
}

export class OmpIdentityError extends Error {
  constructor(message: string, context: string) { super(`${context}: ${message}`); this.name = 'OmpIdentityError'; }
}

export function parseJson(text: string, operation: string, context: string): unknown {
  try { return JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new OmpProtocolError(operation, context, `Invalid JSON: ${error.message}`, { cause: error });
  }
}

export class OmpHostUnavailableError extends Error {
  readonly code = 1;
  constructor(readonly instanceId: string, cause: Error) { super(`Resolve OMP host ${instanceId}: ${cause.message}`, { cause }); this.name = 'OmpHostUnavailableError'; }
}

export class OmpRuntimeStoppingError extends Error {
  constructor(operation = 'OMP runtime operation') { super(`${operation}: OMP runtime is stopping`); this.name = 'OmpRuntimeStoppingError'; }
}

export class OmpHostBusyError extends Error {
  constructor(message: string, context = 'OMP host control') { super(`${context}: ${message}`); this.name = 'OmpHostBusyError'; }
}

export class OmpSessionRetiringError extends Error {
  constructor(message: string, context = 'OMP session operation') { super(`${context}: ${message}`); this.name = 'OmpSessionRetiringError'; }
}

export class OmpDiscoveryTimeoutError extends Error {
  constructor() { super('OMP discovery timed out'); this.name = 'OmpDiscoveryTimeoutError'; }
}

export class OmpCommandError extends Error {
  constructor(operation: string, context: string, cause: Error, readonly code?: string | number | null, readonly signal?: string | null) {
    super(`${operation} (${context}): ${cause.message}`, { cause });
    this.name = 'OmpCommandError';
  }
}

export class OmpProtocolError extends Error {
  constructor(operation: string, context: string, diagnostic: string, options?: ErrorOptions) {
    super(`${operation} (${context}): ${diagnostic}`, options);
    this.name = 'OmpProtocolError';
  }
}

export class OmpHostControlError extends Error {
  constructor(readonly kind: 'busy' | 'rejected' | 'unexpected', operation: string, sessionId: string, diagnostic: string, options?: ErrorOptions) {
    super(`${operation} (session ${sessionId}): ${diagnostic}`, options);
    this.name = 'OmpHostControlError';
  }
}

export class OmpSkillDiscoveryCancelledError extends Error {
  constructor(options?: ErrorOptions) { super('Skill discovery has no remaining consumers', options); this.name = 'OmpSkillDiscoveryCancelledError'; }
}
