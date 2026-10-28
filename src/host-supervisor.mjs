import * as pty from '@lydell/node-pty';
import { closeSync, constants, fchmodSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const filename = join(process.env.OMP_TELEGRAM_SESSION_DIR, 'terminal.log');
const limit = 1024 * 1024;
let fd;
let size = 0;
function openLog() {
  fd = openSync(filename, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  fchmodSync(fd, 0o600);
  size = statSync(filename).size;
}
function log(data) {
  const bytes = Buffer.from(data);
  let offset = 0;
  while (offset < bytes.length) {
    if (size >= limit) {
      closeSync(fd);
      renameSync(filename, `${filename}.1`);
      openLog();
    }
    const length = Math.min(bytes.length - offset, limit - size);
    const written = writeSync(fd, bytes, offset, length);
    offset += written;
    size += written;
  }
}
openLog();
log(`\n--- OMP supervisor started ${new Date().toISOString()} ---\n`);
process.on('uncaughtException', error => {
  try { log(`${error.stack ?? error}\n`); }
  finally { process.exit(1); }
});

const [executable, ...args] = process.argv.slice(2);
const terminal = pty.spawn(executable, args, {
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', OMP_TELEGRAM_SUPERVISOR_PID: String(process.pid) },
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
});
terminal.onData(log);
terminal.onExit(event => {
  log(`\n--- OMP exited: code=${event.exitCode} signal=${event.signal ?? 'none'} ---\n`);
  closeSync(fd);
  process.exitCode = event.exitCode;
});
process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});
