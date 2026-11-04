import { createServer, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TelegramWorker } from '@mtcute/node';
import { z } from 'zod';
import { wire } from './telegram-test-wire.js';
import { TelegramTokenPool } from './telegram-test-pool.js';

const inbound = z.object({ _mtcuteWorkerId: z.string(), connectionId: z.string(), type: z.enum(['connect','release','heartbeat','invoke','abort']), id: z.number().optional(), target: z.string().optional(), method: z.string().optional(), args: z.unknown().optional(), void: z.boolean().optional(), withAbort: z.boolean().optional() }).passthrough();
const allowed: Record<string, readonly string[]> = {
  client: ['prepare','connect','call','notifyChannelOpened','notifyChannelClosed','handleClientUpdate','getPoolSize','getPrimaryDcId','getMtprotoMessageId'],
  'storage-self': ['fetch','storeFrom'],
  'storage-peers': ['getById','getByPhone','getByUsername','store','updatePeersFrom','getCompleteById','getMinAccessHash'],
  'app-config': ['get','getField'],
  timers: ['upsert','cancel','exists'],
};
type Handler = Parameters<TelegramWorker<Record<string, never>>['registerWorker']>[0];
type Response = Parameters<Parameters<Handler>[1]>[0];

export class TelegramSessionService extends TelegramWorker<Record<string, never>> {
  readonly sockets = new Set<Socket>();
  readonly #senders = new Map<Socket, (value: unknown) => void>();
  readonly #server = createServer();
  readonly #connections = new Map<Socket, Promise<void>>();
  readonly #connectionErrors: unknown[] = [];
  #handler?: Handler;
  #listening = false;
  constructor(options: ConstructorParameters<typeof TelegramWorker<Record<string, never>>>[0], readonly pool: TelegramTokenPool, readonly createBot: () => Promise<string>) { super(options); }
  registerWorker(handler: Handler): [(message: Response) => void, () => void] {
    const log = this.client.log.mgr.handler;
    this.#handler = handler;
    return [message => {
      if (message.type === 'log') { log(message.color, message.level, message.tag, message.fmt, message.args); return; }
      for (const send of this.#senders.values()) send(message);
    }, () => {}];
  }
  async listen(path: string): Promise<void> {
    this.mount();
    this.#server.on('connection', socket => {
      this.sockets.add(socket);
      const disconnected = Promise.withResolvers<void>();
      this.#connections.set(socket, disconnected.promise);
      let active = true;
      const owner = randomUUID();
      let connectionId: string | undefined;
      const send = wire(socket, value => {
        const message = inbound.parse(value);
        if (connectionId === undefined) {
          if (message.type !== 'connect') throw new Error('Connect first');
          connectionId = message.connectionId;
        }
        if (message.connectionId !== connectionId) throw new Error('Connection identity changed');
        if (!active && message.type !== 'release') throw new Error('Session connection is closing');
        if (message.type === 'invoke' && message.target === 'custom') {
          const respond = (result?: string, error?: unknown) => send({ _mtcuteWorkerId: message._mtcuteWorkerId, connectionId, type: 'result', id: message.id, result, ...(error === undefined ? {} : { error: { name: error instanceof Error ? error.constructor.name : 'Error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, custom: error instanceof Error ? { ...error } : undefined } }) });
          if (message.method === 'acquire') {
            void this.pool.acquire(owner, this.createBot, () => active && !socket.destroyed).then(token => respond(token), error => respond(undefined, error));
          } else if (message.method === 'releaseToken') {
            try { const [token] = z.tuple([z.string()]).parse(message.args); this.pool.release(owner, token); respond(); } catch (error) { respond(undefined, error); }
          } else if (message.method === 'closeSession') {
            active = false;
            this.pool.quarantine(owner);
            this.#senders.delete(socket);
            this.#handler?.({ _mtcuteWorkerId: this.workerId, connectionId, type: 'release' }, () => {});
            respond();
            socket.end();
          } else throw new Error('Unknown pool operation');
          return;
        }
        if (message.type === 'invoke' && !allowed[message.target ?? '']?.includes(message.method ?? '')) throw new Error('Unsupported session operation');
        this.#handler?.(message as unknown as Parameters<Handler>[0], send);
      });
      this.#senders.set(socket, send);
      socket.on('error', error => this.client.log.warn('Telegram test IPC connection failed: %e', error));
      socket.once('close', () => {
        try {
          if (active) this.pool.quarantine(owner);
          active = false;
          if (connectionId) this.#handler?.({ _mtcuteWorkerId: this.workerId, connectionId, type: 'release' }, () => {});
        } catch (error) {
          this.#connectionErrors.push(error);
          this.client.onError.emit(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.sockets.delete(socket); this.#senders.delete(socket);
          this.#connections.delete(socket); disconnected.resolve();
        }
      });
    });
    const listening = Promise.withResolvers<void>();
    this.#server.once('error', listening.reject);
    this.#server.listen(path, listening.resolve);
    await listening.promise;
    this.#listening = true;
    await chmod(path, 0o600);
  }
  async close(path: string): Promise<void> {
    const errors = this.#connectionErrors;
    for (const socket of this.sockets) socket.destroy();
    const disconnected = Promise.all(this.#connections.values());
    if (this.#listening) {
      const closed = Promise.withResolvers<void>();
      this.#server.close(error => error ? closed.reject(error) : closed.resolve());
      try { await closed.promise; } catch (error) { errors.push(error); }
    }
    await disconnected;
    try { this.destroy(); } catch (error) { errors.push(error); }
    try { await this.pool.close(); } catch (error) { errors.push(error); }
    if (this.#listening) {
      try { await unlink(path); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) errors.push(error); }
      this.#listening = false;
    }
    if (errors.length) throw new AggregateError(errors, 'Telegram session service shutdown failed');
  }
}
