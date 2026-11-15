export class SessionFeedError extends Error {}

export function reportFeedFailure(operation: string, cause: unknown): SessionFeedError {
  const error = new SessionFeedError(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, {cause});
  console.error(error);
  return error;
}
