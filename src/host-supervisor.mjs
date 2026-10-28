import * as pty from '@lydell/node-pty';

const [executable, ...args] = process.argv.slice(2);
const terminal = pty.spawn(executable, args, {
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', OMP_TELEGRAM_SUPERVISOR_PID: String(process.pid) },
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
});
terminal.onData(() => {});
terminal.onExit(event => { process.exitCode = event.exitCode; });
process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});
