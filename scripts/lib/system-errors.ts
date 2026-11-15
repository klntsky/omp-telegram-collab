export class MissingResourceError extends Error {
  constructor(operation: string, cause: Error) {
    super(`${operation}: ${cause.message}`, { cause });
    this.name = 'MissingResourceError';
  }
}

export class ProcessNotRunningError extends Error {
  constructor(operation: string, cause: Error) {
    super(`${operation}: ${cause.message}`, { cause });
    this.name = 'ProcessNotRunningError';
  }
}

/** Translate only errno outcomes with a supported missing-resource meaning. */
export function translateSystemError(operation: string, error: unknown): never {
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT') throw new MissingResourceError(operation, error);
    if (error.code === 'ESRCH') throw new ProcessNotRunningError(operation, error);
  }
  throw error;
}

export async function systemOperation<T>(operation: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { return translateSystemError(operation, error); }
}

export function systemOperationSync<T>(operation: string, action: () => T): T {
  try { return action(); } catch (error) { return translateSystemError(operation, error); }
}
