import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { LocalRelay } from './local-relay.js';
import { errno, openPrivate, prepareRelayDirectory, readDescriptor, reportRelayError, writeDescriptor, type RelayDescriptor } from './relay-state.js';

const directory = process.argv[2];
if (!directory) throw new Error('Relay daemon requires its private state directory');
process.umask(0o077);
prepareRelayDirectory(directory);
const report = (operation: string, error: unknown) => reportRelayError(directory, operation, error);

function notify(message: unknown): void {
  if (!process.connected) return;
  process.send!(message, error => {
    // A launching manager may be cancelled before readiness; it owns no lease yet.
    if (error && !errno(error, 'ERR_IPC_CHANNEL_CLOSED') && !errno(error, 'EPIPE')) report('daemon startup notification', error);
    if (process.connected) process.disconnect?.();
  });
}

async function run(): Promise<void> {
  const lockPath = join(directory, 'owner.sqlite');
  closeSync(openPrivate(lockPath, constants.O_RDWR | constants.O_CREAT));
  const lock = new DatabaseSync(lockPath);
  let relay: LocalRelay | undefined;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (_request, response) => { response.writeHead(404); response.end(); });
  server.maxConnections = 2048;
  const control = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const leases = new Set<WebSocket>();
  const alive = new Set<WebSocket>();
  let idle: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let stopping = false;
  let shuttingDown: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    if (shuttingDown) return shuttingDown;
    stopping = true;
    clearTimeout(idle);
    clearInterval(heartbeat);
    shuttingDown = (async () => {
      const errors: unknown[] = [];
      // Closing the listener and both WebSocket owners is independent. In
      // particular, a failed room teardown cannot leave an unlocked listener.
      const results = await Promise.allSettled([
        (async () => {
          if (!server.listening) return;
          const closed = Promise.withResolvers<void>();
          try { server.close(error => error ? closed.reject(error) : closed.resolve()); }
          catch (error) { closed.reject(error); }
          try { server.closeAllConnections(); }
          catch (error) { errors.push(error); }
          await closed.promise;
        })(),
        (async () => { await relay?.close(); })(),
        (async () => {
          for (const lease of control.clients) {
            try { lease.terminate(); }
            catch (error) { errors.push(error); }
          }
          const closed = Promise.withResolvers<void>();
          control.close(error => error ? closed.reject(error) : closed.resolve());
          await closed.promise;
        })(),
      ]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (server.listening) {
        errors.push(new Error('Local relay listener remains open; retaining exclusive daemon ownership'));
      } else {
        try { lock.close(); }
        catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.stack ?? error.message : String(error)).join('\n'));
    })();
    return shuttingDown;
  }

  function activity(): void {
    clearTimeout(idle);
    if (!stopping && leases.size === 0 && relay?.hostCount === 0) {
      idle = setTimeout(() => { void shutdown().catch(error => { report('daemon idle shutdown', error); process.exitCode = 1; }); }, 5000);
    }
  }

  try {
    // Kernel-owned SQLite locks disappear on crash. Never unlink a lock or kill a
    // PID from stale metadata: either could belong to a different live owner.
    lock.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL); DELETE FROM owner;');
    lock.prepare('INSERT INTO owner (pid) VALUES (?)').run(process.pid);
    const previous = readDescriptor(directory);
    const identity = randomBytes(32).toString('hex');
    const token = randomBytes(32).toString('hex');
    let descriptor: RelayDescriptor;
    relay = new LocalRelay(activity, report);
    control.on('error', error => report('daemon control server', error));
    control.on('connection', socket => {
      leases.add(socket);
      alive.add(socket);
      activity();
      socket.on('pong', () => alive.add(socket));
      socket.on('error', error => { report('daemon lease', error); socket.terminate(); });
      socket.on('message', () => socket.close(1008, 'Lease is receive-only'));
      socket.on('close', () => { leases.delete(socket); alive.delete(socket); activity(); });
      socket.send(JSON.stringify({ version: 1, pid: descriptor.pid, identity, url: descriptor.url }), error => {
        if (error) { report('daemon lease acknowledgement', error); socket.terminate(); }
      });
    });
    server.on('upgrade', (request, socket, head) => {
      socket.on('error', error => report('daemon upgrade transport', error));
      if (stopping) { socket.destroy(); return; }
      if (request.url === '/lease') {
        const authorization = request.headers.authorization;
        const supplied = typeof authorization === 'string' ? Buffer.from(authorization) : Buffer.alloc(0);
        const expected = Buffer.from(`Bearer ${token}`);
        if (leases.size >= 16 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        control.handleUpgrade(request, socket, head, client => control.emit('connection', client));
      } else relay!.upgrade(request, socket, head);
    });
    server.on('clientError', (error, socket) => { report('daemon HTTP client', error); socket.destroy(); });
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(previous?.port ?? 0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.removeListener('error', listening.reject);
    server.on('error', error => {
      report('daemon listener', error);
      void shutdown().catch(cleanup => report('daemon listener shutdown', cleanup));
      process.exitCode = 1;
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local relay has no TCP address');
    descriptor = { version: 1, pid: process.pid, identity, token, port: address.port, url: `ws://127.0.0.1:${address.port}` };
    writeDescriptor(directory, descriptor);
    heartbeat = setInterval(() => {
      for (const socket of leases) {
        if (!alive.delete(socket)) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 15_000);
    heartbeat.unref();
    const signal = () => { void shutdown().catch(error => { report('daemon signal shutdown', error); process.exitCode = 1; }); };
    process.once('SIGTERM', signal);
    process.once('SIGINT', signal);
    activity();
    notify({ ready: true, descriptor });
  } catch (error) {
    try { await shutdown(); }
    catch (cleanup) { report('daemon startup cleanup', cleanup); }
    throw error;
  }
}

void run().catch(error => {
  report('daemon startup', error);
  notify({ ready: false, error: { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, code: error instanceof Error && 'code' in error ? error.code : undefined } });
  process.exitCode = 1;
});
