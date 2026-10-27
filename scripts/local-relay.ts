import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

interface Room {
  host: WebSocket;
  guests: Map<number, WebSocket>;
  nextPeer: number;
}

export async function startLocalRelay() {
  const rooms = new Map<string, Room>();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024 });
  server.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const roomId = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname)?.[1];
    const role = url.searchParams.get('role');
    if (!roomId || (role !== 'host' && role !== 'guest')) {
      socket.close(1008, 'Invalid room');
      return;
    }
    let peer = 0;
    if (role === 'host') {
      if (rooms.has(roomId)) {
        socket.close(4009, 'Host already connected');
        return;
      }
      rooms.set(roomId, { host: socket, guests: new Map(), nextPeer: 1 });
    } else {
      const room = rooms.get(roomId);
      if (!room) {
        socket.close(4004, 'No such room');
        return;
      }
      peer = room.nextPeer++;
      room.guests.set(peer, socket);
      room.host.send(JSON.stringify({ t: 'peer-joined', peer }));
    }
    socket.on('error', () => socket.close());
    socket.on('message', (data, binary) => {
      if (!binary) return;
      const room = rooms.get(roomId);
      const bytes = Buffer.from(data as Buffer);
      if (!room || bytes.length < 4) return;
      if (role === 'guest') {
        bytes.writeUInt32BE(peer, 0);
        if (room.host.readyState === WebSocket.OPEN) room.host.send(bytes);
        return;
      }
      const target = bytes.readUInt32BE(0);
      const destinations = target === 0 ? room.guests.values() : [room.guests.get(target)];
      for (const guest of destinations) {
        if (guest?.readyState === WebSocket.OPEN) guest.send(bytes);
      }
    });
    socket.on('close', () => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (role === 'host' && room.host === socket) {
        rooms.delete(roomId);
        for (const guest of room.guests.values()) {
          guest.send(JSON.stringify({ t: 'room-closed' }));
          guest.close(4001, 'Room closed');
        }
      } else if (role === 'guest' && room.guests.delete(peer) && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({ t: 'peer-left', peer }));
      }
    });
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Relay has no TCP address');
  return {
    url: `ws://localhost:${address.port}`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close(error => error ? reject(error) : resolve());
      await promise;
    },
  };
}
