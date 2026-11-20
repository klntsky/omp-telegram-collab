import { writeSync } from 'node:fs';
import { HttpError } from 'grammy';
import { channel } from 'node:diagnostics_channel';

const records = channel('omp-telegram.log');

export function errorDiagnostic(error: unknown, seen?: WeakSet<object>): unknown {
  if (!(error instanceof Error)) return error;
  seen ??= new WeakSet<object>();
  if (seen.has(error)) return { name: error.name, circular: true };
  seen.add(error);
  // execFile includes the full command and its arguments in both message and stack.
  const commandFailure = typeof Reflect.get(error, 'cmd') === 'string';
  const diagnostic: Record<string, unknown> = commandFailure
    ? { name: error.name }
    : { name: error.name, message: error.message, stack: error.stack };
  for (const field of ['code', 'errno', 'syscall', 'signal', 'killed', 'exitCode', 'status', 'statusCode', 'error_code', 'description', 'type', 'seconds']) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      diagnostic[field] = value;
  }
  if (error instanceof HttpError) {
    // grammY toHttpError keeps its safe diagnostic outside the URL-bearing fetch error.
    // https://github.com/grammyjs/grammY/blob/v1.46.0/src/core/error.ts
    const transport = error.error;
    if (transport && typeof transport === 'object') {
      const details: Record<string, unknown> = {};
      for (const field of ['code', 'errno', 'syscall', 'type']) {
        const value: unknown = Reflect.get(transport, field);
        if (typeof value === 'string' || typeof value === 'number') details[field] = value;
      }
      diagnostic.transport = details;
    }
    seen.delete(error);
    return diagnostic;
  }
  if (error.cause !== undefined) diagnostic.cause = errorDiagnostic(error.cause, seen);
  if (error instanceof AggregateError) diagnostic.errors = error.errors.map(value => errorDiagnostic(value, seen));
  seen.delete(error);
  return diagnostic;
}

export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const record = JSON.stringify({ ...fields, event, level, at: new Date().toISOString() }, (_key, value: unknown) =>
    value instanceof Error ? errorDiagnostic(value) : value);
  writeSync(2, `${record}\n`);
  if (records.hasSubscribers) records.publish(record);
}
