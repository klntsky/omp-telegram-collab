import { connect, type Socket } from 'node:net';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TelegramClient, TelegramWorkerPort, tl } from '@mtcute/node';
import { z } from 'zod';
import { wire } from './telegram-test-wire.js';

export function telegramTestPaths(env: NodeJS.ProcessEnv = process.env): { directory: string; socket: string } {
  const directory = env.TELEGRAM_TEST_DATA_DIR ?? join(homedir(), '.local/state/omp-telegram-test');
  return { directory, socket: env.TELEGRAM_TEST_SOCKET ?? join(directory, 'session.sock') };
}
export interface TelegramTestSession {
  client: TelegramClient;
  acquire(): Promise<string>;
  release(token: string): Promise<void>;
  close(): Promise<void>;
}
const sockets = new WeakMap<object, { socket: Socket; failure: Promise<never> }>();
const outbound = z.object({ _mtcuteWorkerId: z.string(), type: z.enum(['server_update','update','error','stop','conn_state','self_sync','connection_expired','result','log']) }).passthrough();
type SessionMethods = {
  acquire(): Promise<string>;
  releaseToken(token: string): Promise<void>;
  closeSession(): Promise<void>;
};
type SessionPort = TelegramWorkerPort<SessionMethods>;
type PortOptions = Parameters<SessionPort['connectToWorker']>;
class SocketPort extends TelegramWorkerPort<SessionMethods> {
  private get failure(): Promise<never> {
    const connection = sockets.get(this.options.worker);
    if (!connection) throw new Error('Missing session socket');
    return connection.failure;
  }
  override call<T extends tl.RpcMethod>(request: T, options?: Parameters<SessionPort['call']>[1]): Promise<tl.RpcCallReturn[T['_']]> {
    return Promise.race([super.call(request, options), this.failure]);
  }
  override connect(): Promise<void> {
    return Promise.race([super.connect(), this.failure]);
  }
  override connectToWorker(worker: PortOptions[0], handler: PortOptions[1]): ReturnType<SessionPort['connectToWorker']> {
    const socket = sockets.get(worker)?.socket;
    if (!socket) throw new Error('Missing session socket');
    const send = wire(socket, value => {
      const message = outbound.parse(value);
      handler(message as unknown as Parameters<PortOptions[1]>[0]);
    });
    return [send, () => socket.destroy()];
  }
}
export async function connectTelegramTestSession(path = telegramTestPaths().socket, signal?: AbortSignal): Promise<TelegramTestSession> {
  signal?.throwIfAborted();
  const socket = connect(path);
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  let errorClient: TelegramClient | undefined;
  socket.on('error', error => { failure.reject(error); errorClient?.onError.emit(error); });
  const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Session connection aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  try { await once(socket, 'connect', { signal }); }
  catch (error) { socket.destroy(); signal?.removeEventListener('abort', abort); throw error; }
  const { port1, port2 } = new MessageChannel();
  // Public worker-port transport hook uses this inert MessagePort only as an identity handle.
  sockets.set(port1, { socket, failure: failure.promise });
  const port = new SocketPort({ worker: port1 });
  const client = new TelegramClient({ client: port, skipConversationUpdates: false });
  errorClient = client;
  let closing: Promise<void> | undefined;
  const disconnected = Promise.withResolvers<void>();
  socket.once('close', () => {
    failure.reject(Object.assign(new Error('Telegram test session disconnected'), { code: 'ERR_TELEGRAM_TEST_DISCONNECTED' }));
    void port.destroy(); port1.close(); port2.close(); disconnected.resolve();
  });
  try { await client.connect(); }
  catch (error) { await port.destroy(); port1.close(); port2.close(); socket.destroy(); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
  return {
    client,
    acquire: async () => await Promise.race([port.invokeCustom('acquire'), failure.promise]),
    release: async (token: string) => { await Promise.race([port.invokeCustom('releaseToken', token), failure.promise]); },
    close() {
      closing ??= (async () => {
        try { if (!socket.destroyed) await Promise.race([port.invokeCustom('closeSession'), failure.promise]); }
        finally {
          await client.destroy();
          socket.destroy(); port1.close(); port2.close();
          await disconnected.promise;
        }
      })();
      return closing;
    },
  };
}
