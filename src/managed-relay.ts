import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { relayDaemonExecArgs, relayDaemonPath } from './host-assets.js';
import { childEnvironment } from './runtime/environment.js';
import { errno, openPrivate, prepareRelayDirectory, readDescriptor, relayDirectory, reportRelayError, type RelayDescriptor } from './relay-state.js';

/** Owns a service lease, not the detached process or any native host lifetime. */
export class ManagedRelay {
  private readonly directory: string;
  private readonly cancellation = new AbortController();
  private readonly closedError = new Error('Managed relay is closed');
  private acquiring: Promise<string> | undefined;
  private lease: WebSocket | undefined;
  private url: string | undefined;
  private retry: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private prepared = false;

  constructor(dataDir: string) { this.directory = relayDirectory(dataDir); }

  async ensure(): Promise<string> {
    if (this.cancellation.signal.aborted) throw this.closedError;
    if (this.lease?.readyState === WebSocket.OPEN && this.url) return this.url;
    if (this.lease) {
      clearInterval(this.heartbeat);
      this.lease.terminate();
      this.lease = undefined;
    }
    if (!this.acquiring) {
      clearTimeout(this.retry);
      this.retry = undefined;
      this.acquiring = this.acquire().catch(error => {
        if (error !== this.closedError && this.prepared) reportRelayError(this.directory, 'manager acquisition', error);
        throw error;
      }).finally(() => {
        this.acquiring = undefined;
        if (!this.lease) this.schedule();
      });
    }
    return this.acquiring;
  }

  private schedule(): void {
    if (this.cancellation.signal.aborted || !this.prepared || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      // ensure owns persistent reporting; this retry has no foreground caller.
      void this.ensure().catch(() => undefined);
    }, 1000);
    this.retry.unref();
  }

  private async acquire(): Promise<string> {
    prepareRelayDirectory(this.directory);
    this.prepared = true;
    const descriptor = readDescriptor(this.directory);
    if (descriptor) {
      try { return await this.connect(descriptor); }
      catch (error) {
        // Refusal means there is no listener. A responding but unauthenticated
        // listener must never be adopted, replaced, or killed from its PID.
        if (!errno(error, 'ECONNREFUSED')) throw error;
        reportRelayError(this.directory, 'manager reconnect', error);
      }
    }
    if (this.cancellation.signal.aborted) throw this.closedError;
    await this.launch();
    if (this.cancellation.signal.aborted) throw this.closedError;
    const ready = readDescriptor(this.directory);
    if (!ready) throw new Error('Local relay started without publishing its descriptor');
    return this.connect(ready);
  }

  private connect(descriptor: RelayDescriptor): Promise<string> {
    const result = Promise.withResolvers<string>();
    const socket = new WebSocket(`${descriptor.url}/lease`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
      handshakeTimeout: 3000,
      maxPayload: 1024,
      perMessageDeflate: false,
    });
    let settled = false;
    let accepted = false;
    let lastHeard = Date.now();
    const timer = setTimeout(() => fail(new Error('Local relay identity handshake timed out')), 4000);
    const abort = () => fail(this.closedError);
    const cleanup = () => {
      clearTimeout(timer);
      this.cancellation.signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.terminate();
      result.reject(error);
    };
    this.cancellation.signal.addEventListener('abort', abort, { once: true });
    if (this.cancellation.signal.aborted) abort();
    socket.on('error', error => {
      if (!settled) fail(error);
      else if (accepted && !this.cancellation.signal.aborted) {
        reportRelayError(this.directory, 'manager lease transport', error);
        socket.terminate();
      }
      // After failed acquisition, ws can emit the error caused by terminate();
      // the rejection already owns the original diagnostic or typed cancellation.
    });
    socket.on('ping', () => { lastHeard = Date.now(); });
    socket.on('pong', () => { lastHeard = Date.now(); });
    socket.on('message', (data, binary) => {
      if (settled) return;
      try {
        const hello = binary ? undefined : JSON.parse(data.toString()) as Partial<RelayDescriptor>;
        if (!hello || hello.version !== 1 || hello.pid !== descriptor.pid || hello.identity !== descriptor.identity || hello.url !== descriptor.url) {
          throw new Error('Local relay control identity does not match its private descriptor');
        }
        if (this.cancellation.signal.aborted) { fail(this.closedError); return; }
        settled = true;
        accepted = true;
        cleanup();
        this.lease = socket;
        this.url = descriptor.url;
        this.heartbeat = setInterval(() => {
          if (Date.now() - lastHeard > 40_000) {
            reportRelayError(this.directory, 'manager lease heartbeat', new Error('Local relay lease heartbeat timed out'));
            socket.terminate();
          } else if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, 15_000);
        this.heartbeat.unref();
        result.resolve(descriptor.url);
      } catch (error) { fail(error); }
    });
    socket.on('close', (code, reason) => {
      if (!settled) fail(new Error(`Local relay lease closed before identity acknowledgement (${code}): ${reason.toString()}`));
      if (this.lease !== socket) return;
      clearInterval(this.heartbeat);
      this.lease = undefined;
      if (!this.cancellation.signal.aborted) {
        reportRelayError(this.directory, 'manager lease disconnected', new Error(`Local relay lease closed (${code}): ${reason.toString()}`));
        this.schedule();
      }
    });
    return result.promise;
  }

  private async launch(): Promise<void> {
    const logfile = join(this.directory, 'relay.log');
    const fd = openPrivate(logfile, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    const start = fstatSync(fd).size;
    const child = (() => {
      try {
        return spawn(process.execPath, [...relayDaemonExecArgs, relayDaemonPath, this.directory], {
          detached: true,
          env: childEnvironment(),
          stdio: ['ignore', fd, fd, 'ipc'],
        });
      } finally { closeSync(fd); }
    })();
    child.unref();
    const result = Promise.withResolvers<void>();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.cancellation.signal.removeEventListener('abort', abort);
      if (child.connected) child.disconnect();
      if (error) result.reject(error);
      else result.resolve();
    };
    const abort = () => finish(this.closedError);
    const timer = setTimeout(() => finish(new Error('Local relay daemon startup timed out')), 10_000);
    this.cancellation.signal.addEventListener('abort', abort, { once: true });
    if (this.cancellation.signal.aborted) abort();
    child.on('error', error => {
      if (!settled) finish(error);
      else reportRelayError(this.directory, 'daemon child process', error);
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('ready' in message)) { finish(new Error('Invalid local relay daemon startup response')); return; }
      if (message.ready === true) finish();
      else if ('error' in message && message.error && typeof message.error === 'object' && 'message' in message.error) {
        const diagnostic = message.error as { message: string; stack?: string; code?: string };
        const error = new Error(diagnostic.message);
        if (diagnostic.stack) error.stack = diagnostic.stack;
        if (diagnostic.code) Object.assign(error, { code: diagnostic.code });
        finish(error);
      } else finish(new Error('Invalid local relay daemon startup error'));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      try {
        const log = openPrivate(logfile, constants.O_RDONLY);
        let diagnostics: string;
        try {
          const bytes = Buffer.alloc(Math.max(0, fstatSync(log).size - start));
          const count = readSync(log, bytes, 0, bytes.length, start);
          diagnostics = bytes.subarray(0, count).toString();
        } finally { closeSync(log); }
        finish(new Error(`Local relay daemon exited before readiness (code=${code}, signal=${signal})\n${diagnostics}`));
      } catch (error) { finish(error); }
    });
    return result.promise;
  }

  async close(): Promise<void> {
    this.cancellation.abort(this.closedError);
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const socket = this.lease;
    this.lease = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = Promise.withResolvers<void>();
      socket.once('close', closed.resolve);
      socket.terminate();
      await closed.promise;
    }
    // Every non-cancellation acquisition error is already recorded by ensure.
    await this.acquiring?.catch(() => undefined);
  }
}
