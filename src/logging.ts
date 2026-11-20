import { writeSync } from 'node:fs';
import { inspect } from 'node:util';
import { channel } from 'node:diagnostics_channel';

const records = channel('omp-telegram.log');

export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const record = JSON.stringify({ ...fields, event, level, at: new Date().toISOString() }, (_key, value: unknown) =>
    value instanceof Error ? {
      name: value.name,
      message: value.message,
      stack: value.stack,
      // Native errors and subprocess failures carry non-enumerable diagnostics, including causes.
      diagnostic: inspect(value, { depth: null, showHidden: true, colors: false, maxArrayLength: null, maxStringLength: null }),
    } : value);
  writeSync(2, `${record}\n`);
  if (records.hasSubscribers) records.publish(record);
}
