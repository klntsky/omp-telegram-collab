import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_SOCKET_QUEUE = 32 * 1024 * 1024;
const MAX_TOTAL_QUEUE = 64 * 1024 * 1024;

interface Room {
  host: WebSocket;
  guests: Map<number, WebSocket>;
  nextPeer: number;
}

/** Only the four-byte routing envelope is inspected; encrypted payloads remain opaque. */
export class LocalRelay {
  // Yield between received messages so outbound completion can release input
  // backpressure before the receiver parses its next buffered frame.
  // https://github.com/websockets/ws/blob/8.22.0/lib/receiver.js#L605-L614
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false, allowSynchronousEvents: false });
  private readonly rooms = new Map<string, Room>();
  private readonly alive = new Set<WebSocket>();
  private readonly forwarding = new Map<WebSocket, number>();
  private queuedBytes = 0;
  private readonly heartbeat: NodeJS.Timeout;
  private closing: Promise<void> | undefined;

  constructor(private readonly changed: () => void, private readonly report: (operation: string, error: unknown) => void) {
    this.server.on('connection', (socket, request) => this.connected(socket, request));
    this.server.on('error', error => report('relay server', error));
    this.heartbeat = setInterval(() => {
      for (const socket of this.server.clients) {
        // A backpressured producer cannot read its pong yet. Its blocked
        // destination is still probed and will release this pause on closure.
        if (this.forwarding.has(socket)) { this.alive.add(socket); continue; }
        if (!this.alive.delete(socket)) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  get hostCount(): number { return this.rooms.size; }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.server.clients.size >= 1024) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.server.handleUpgrade(request, socket, head, client => this.server.emit('connection', client, request));
  }

  private send(socket: WebSocket, data: Buffer | string, source?: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    if (socket.bufferedAmount + bytes > MAX_SOCKET_QUEUE || this.queuedBytes + bytes > MAX_TOTAL_QUEUE) {
      this.report('relay backpressure', new Error(
        `Relay outbound queue capacity exceeded; disconnecting slow consumer (socketBytes=${socket.bufferedAmount}, frameBytes=${bytes}, totalBytes=${this.queuedBytes})`,
      ));
      socket.terminate();
      return;
    }
    this.queuedBytes += bytes;
    // A full snapshot can exceed the output budget while its consumer is
    // briefly busy. Stop reading its producer instead of disconnecting and
    // replaying the snapshot forever. Fanout resumes only after every write
    // from this producer completes; already-parsed input stays byte-bounded.
    // ws.pause/resume and its stream adapter use the same TCP flow control:
    // https://github.com/websockets/ws/blob/8.22.0/lib/stream.js#L62-L67
    if (source) {
      this.forwarding.set(source, (this.forwarding.get(source) ?? 0) + 1);
      source.pause();
    }
    socket.send(data, error => {
      this.queuedBytes -= bytes;
      if (source) {
        const remaining = this.forwarding.get(source)! - 1;
        if (remaining) this.forwarding.set(source, remaining);
        else {
          this.forwarding.delete(source);
          if (source.readyState === WebSocket.OPEN) source.resume();
        }
      }
      if (error) {
        this.report('relay send', error);
        socket.terminate();
      }
    });
  }

  private connected(socket: WebSocket, request: IncomingMessage): void {
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    socket.on('error', error => { this.report('relay connection', error); socket.terminate(); });
    socket.on('close', () => this.alive.delete(socket));
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
    catch { socket.close(1008, 'Invalid room'); return; }
    const roomId = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname)?.[1];
    const role = url.searchParams.get('role');
    if (!roomId || (role !== 'host' && role !== 'guest')) {
      socket.close(1008, 'Invalid room');
      return;
    }
    let peer = 0;
    let room: Room;
    if (role === 'host') {
      if (this.rooms.has(roomId)) { socket.close(4009, 'Host already connected'); return; }
      if (this.rooms.size >= 256) { socket.close(4029, 'Relay full'); return; }
      room = { host: socket, guests: new Map(), nextPeer: 1 };
      this.rooms.set(roomId, room);
      this.changed();
    } else {
      const existing = this.rooms.get(roomId);
      if (!existing) { socket.close(4004, 'No such room'); return; }
      room = existing;
      if (room.guests.size >= 64 || room.nextPeer > 0xffffffff) { socket.close(4029, 'Room full'); return; }
      peer = room.nextPeer++;
      room.guests.set(peer, socket);
      this.send(room.host, JSON.stringify({ t: 'peer-joined', peer }));
    }
    // Matches upstream CollabSocket and packEnvelope: the relay replaces a guest's
    // peer header, but never decrypts or interprets the remaining bytes.
    // https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/collab/relay-client.ts
    socket.on('message', (data, binary) => {
      if (!binary || this.rooms.get(roomId) !== room) return;
      const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
      if (bytes.length < 4) { socket.close(1008, 'Invalid envelope'); return; }
      if (role === 'guest') {
        bytes.writeUInt32BE(peer, 0);
        this.send(room.host, bytes, socket);
      } else {
        const target = bytes.readUInt32BE(0);
        if (target === 0) for (const guest of room.guests.values()) this.send(guest, bytes, socket);
        else {
          const guest = room.guests.get(target);
          if (guest) this.send(guest, bytes, socket);
        }
      }
    });
    socket.on('close', () => {
      if (this.rooms.get(roomId) !== room) return;
      if (role === 'host') {
        this.rooms.delete(roomId);
        for (const guest of room.guests.values()) {
          this.send(guest, JSON.stringify({ t: 'room-closed' }));
          guest.close(4001, 'Room closed');
        }
        this.changed();
      } else if (room.guests.delete(peer)) this.send(room.host, JSON.stringify({ t: 'peer-left', peer }));
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.heartbeat);
      const errors: unknown[] = [];
      for (const socket of this.server.clients) {
        try { socket.terminate(); }
        catch (error) { errors.push(error); }
      }
      const closed = Promise.withResolvers<void>();
      try {
        this.server.close(error => error ? closed.reject(error) : closed.resolve());
        await closed.promise;
      } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.stack ?? error.message : String(error)).join('\n'));
    })();
  }
}

export async function startLocalRelay(options: { port?: number; report?: (operation: string, error: unknown) => void } = {}) {
  const report = options.report ?? ((operation: string, error: unknown) => console.error(operation, error));
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (_request, response) => { response.writeHead(404); response.end(); });
  server.maxConnections = 2048;
  const relay = new LocalRelay(() => undefined, report);
  server.on('upgrade', (request, socket, head) => relay.upgrade(request, socket, head));
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(options.port ?? 0, '127.0.0.1', listening.resolve);
  try { await listening.promise; }
  catch (error) {
    try { await relay.close(); }
    catch (cleanup) { report('relay startup cleanup', cleanup); }
    throw error;
  }
  server.removeListener('error', listening.reject);
  server.on('error', error => report('relay listener', error));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Relay has no TCP address');
  let closing: Promise<void> | undefined;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      return closing ??= (async () => {
        // Stop accepting before waiting for WebSocket teardown. Both owners must
        // attempt cleanup even when the other fails, and retain every diagnostic.
        const errors: unknown[] = [];
        const results = await Promise.allSettled([
          (async () => {
            const closed = Promise.withResolvers<void>();
            try { server.close(error => error ? closed.reject(error) : closed.resolve()); }
            catch (error) { closed.reject(error); }
            try { server.closeAllConnections(); }
            catch (error) { errors.push(error); }
            await closed.promise;
          })(),
          relay.close(),
        ]);
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.stack ?? error.message : String(error)).join('\n'));
      })();
    },
  };
}
