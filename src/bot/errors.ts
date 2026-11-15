export class BotCancellationError extends Error {}
export class BotOperationTimeoutError extends Error {}
export class DocumentDestinationError extends Error {}
export class BotSessionStateError extends Error {}
export class BotPromptRejectedError extends Error {}
export class BotSettingsRejectedError extends Error {}
export class BotCommandRejectedError extends Error {}
export class BotFolderRequestError extends Error {}
export class BotWorkingDirectoryError extends Error {}
export class FolderSelectionError extends Error {
  constructor(readonly code: string, operation: string, path: string, cause: Error) {
    super(`${operation} failed (path=${JSON.stringify(path)}): ${cause.message}`, {cause});
  }
}

/** Reporting unknown failures is operational ownership, not classification as a supported outcome. */
export function reportBotError(operation: string, error: unknown, identifiers?: Record<string, unknown>): void {
  const context = identifiers ? `${operation} ${JSON.stringify(identifiers)}` : operation;
  if (error instanceof Error) {
    // Retain identity, subclass, cause, and dependency-specific diagnostic fields.
    if (!error.message.startsWith(`${context}: `)) error.message = `${context}: ${error.message}`;
    console.error(context, error);
  } else {
    console.error(new Error(`${context}: ${String(error)}`, {cause: error}));
  }
}
