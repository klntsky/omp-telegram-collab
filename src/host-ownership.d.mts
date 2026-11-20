import type { DatabaseSync } from 'node:sqlite';

export function acquireHostOwnership(directory: string): Promise<DatabaseSync>;
