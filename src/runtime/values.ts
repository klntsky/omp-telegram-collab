import { OmpSystemError } from './errors.js';
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errno(error: unknown, code: string): boolean {
  return error instanceof OmpSystemError && error.code === code;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const RETIREMENT_GRANT = /^retirement-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.request$/;
