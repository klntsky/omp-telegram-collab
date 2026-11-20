import { fileURLToPath } from 'node:url';

// These helpers sit beside this root module in source and beside the bundled CLI
// in dist. Resolving from a nested operation module would break one of those layouts.
export const hostSupervisorPath = fileURLToPath(new URL('./host-supervisor.mjs', import.meta.url));
export const hostLifecyclePath = fileURLToPath(new URL('./host-lifecycle.mjs', import.meta.url));
export const relayDaemonPath = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './relay-daemon.ts' : './relay-daemon.js', import.meta.url));
export const relayDaemonExecArgs = relayDaemonPath.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
