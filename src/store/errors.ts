import type { DatabaseSync } from 'node:sqlite';

export class StoreStateError extends Error {}
export class StoreOperationError extends Error {}

export function rollbackStore(db: DatabaseSync, operation: string, primary: unknown): never {
  try { if (db.isTransaction) db.exec('ROLLBACK'); }
  catch (cleanupError) {
    throw new AggregateError([primary, cleanupError], `${operation}: ${primary instanceof Error ? primary.message : String(primary)}\nRollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, {cause: primary});
  }
  if (primary instanceof StoreStateError) throw primary;
  throw new StoreOperationError(`${operation}: ${primary instanceof Error ? primary.message : String(primary)}`, {cause: primary});
}
