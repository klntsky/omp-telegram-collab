export class TelegramTestTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Telegram test ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TelegramTestTimeoutError';
  }
}

export class TelegramTestCancellationError extends Error {
  constructor(operation: string) {
    super(`Telegram test ${operation}`);
    this.name = 'TelegramTestCancellationError';
  }
}

export class TelegramTestConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TelegramTestConfigurationError';
  }
}

export function decodeTelegramTestConfiguration(value: string, key: string): unknown {
  try { return JSON.parse(value); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (key === 'TELEGRAM_TEST_SESSIONS' || key === 'TELEGRAM_TEST_BOT_TOKENS') {
      // V8 can quote arbitrary credential fragments, not just complete known
      // values. Secret exclusion overrides exact diagnostic retention here:
      // keep safe parser coordinates and the original cause identity, but
      // regenerate its stack from a safe message so even multiline source
      // excerpts resembling stack frames cannot leak through CLI reports.
      const location = /at position \d+(?: \(line \d+ column \d+\))?$/.exec(error.message)?.[0];
      error.message = `Invalid credential JSON${location ? ` ${location}` : ''} (source excerpt redacted)`;
      error.stack = new SyntaxError(error.message).stack;
    }
    throw new TelegramTestConfigurationError(`Decode ${key}: ${error.message}`, { cause: error });
  }
}

export class TelegramTestAuthorizationError extends Error {}
export class TelegramTestProvisioningError extends Error {}
export class TelegramTestStorageSafetyError extends Error {}
export class TelegramTestLeaseError extends Error {}
export class ScriptUsageError extends Error {}
export class TelegramTestSessionUnavailableError extends AggregateError {}
export class TelegramTestRetryBudgetError extends Error {}
