import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface RelayDescriptor {
  version: 1;
  pid: number;
  identity: string;
  token: string;
  port: number;
  url: string;
}

export function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function relayDirectory(dataDir: string): string { return resolve(dataDir, 'local-relay'); }

export function prepareRelayDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Local relay directory must be an owned, non-symlink directory');
  }
  chmodSync(directory, 0o700);
}

export function openPrivate(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Local relay artifact must be an owned regular file');
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readDescriptor(directory: string): RelayDescriptor | undefined {
  let fd: number;
  try { fd = openPrivate(join(directory, 'descriptor.json'), constants.O_RDONLY); }
  catch (error) { if (errno(error, 'ENOENT')) return undefined; throw error; }
  let value: RelayDescriptor;
  try { value = JSON.parse(readFileSync(fd, 'utf8')) as RelayDescriptor; }
  finally { closeSync(fd); }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity) ||
      typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) ||
      value.url !== `ws://127.0.0.1:${value.port}`) throw new Error('Invalid local relay descriptor');
  return value;
}

export function writeDescriptor(directory: string, descriptor: RelayDescriptor): void {
  // Only the SQLite lock owner publishes. Atomic replacement keeps crash recovery
  // from interpreting partial JSON; the descriptor survives shutdown to pin the port.
  const temporary = join(directory, 'descriptor.next');
  const fd = openPrivate(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
  try { writeFileSync(fd, JSON.stringify(descriptor)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, join(directory, 'descriptor.json'));
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directoryFd); }
  finally { closeSync(directoryFd); }
}

export function reportRelayError(directory: string, operation: string, error: unknown): void {
  const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    const fd = openPrivate(join(directory, 'relay.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    try { appendFileSync(fd, `${new Date().toISOString()} ${operation}: ${diagnostic}\n`); }
    finally { closeSync(fd); }
  } catch (logging) {
    throw new AggregateError([error, logging], `${operation}: ${diagnostic}\nRecording relay diagnostic failed: ${logging instanceof Error ? logging.message : String(logging)}`);
  }
}
