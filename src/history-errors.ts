export class HistorySourceError extends Error {}
export class HistoryClosedError extends Error {}
export class HistoryStateError extends Error {}

// Native file errors are recoverable history-source failures, not evidence that a programming error can be retried.
export async function historyOperation<T>(context: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
    throw new HistorySourceError(`${context}: ${error.message}`, {cause: error});
  }
}
