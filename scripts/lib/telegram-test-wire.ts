import { serialize, deserialize } from 'node:v8';
import type { Socket } from 'node:net';

export function wire(socket: Socket, receive: (value: unknown) => void): (value: unknown) => void {
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length > 64 * 1024 * 1024) { socket.destroy(Object.assign(new Error('IPC frame too large'), { code: 'ERR_TELEGRAM_TEST_FRAME_TOO_LARGE' })); return; }
      if (pending.length < length + 4) return;
      const frame = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      try { receive(deserialize(frame)); } catch (error) { socket.destroy(error as Error); return; }
    }
  });
  return value => {
    if (socket.destroyed || socket.writableEnded) return;
    const data = serialize(value);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(data.length);
    socket.cork(); socket.write(header); socket.write(data); socket.uncork();
  };
}
