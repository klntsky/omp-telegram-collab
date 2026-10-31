import { COLLAB_PROTO, type SessionState, type GuestFrame, type HostFrame } from '@oh-my-pi/pi-wire';
import WebSocket from 'ws';
import type { CollabConnection, CollabHandlers, HostBinding } from '../shared/contracts.js';
import { importRoomKey, open, seal } from './vendor/codec.js';
import { encodeBase64Url, packEnvelope, parseCollabLink, unpackEnvelope } from './vendor/link.js';

const SETUP_TIMEOUT_MS = 60_000;
const HOST_TYPES: Record<string, true> = {
  welcome: true, 'snapshot-chunk': true, entry: true, event: true, state: true, bus: true, agents: true,
  'ui-request': true, 'ui-request-end': true, transcript: true, bye: true, error: true,
};
const GUEST_TYPES: Record<string, true> = {
  prompt: true, abort: true, 'agent-cmd': true, 'fetch-transcript': true, 'ui-response': true,
};

export function isStartupRejection(frame: HostFrame): boolean {
  return frame.t === 'error' && frame.message === 'prompting is unavailable until the host finishes starting up';
}

export async function readCollabState(
  binding: HostBinding,
  name: string,
  signal?: AbortSignal,
): Promise<SessionState> {
  let state!: SessionState;
  await openCollab(binding, name, {
    onFrame(frame) {
      if (frame.t === 'welcome') {
        if (!frame.state || typeof frame.state !== 'object' || typeof frame.state.isStreaming !== 'boolean' ||
            !Number.isSafeInteger(frame.state.queuedMessageCount) || frame.state.queuedMessageCount < 0) {
          throw new Error('Invalid Collab activity state');
        }
        state = frame.state;
      }
    },
    onClose() {},
  }, signal, true);
  return state;
}

export function connectCollab(
  binding: HostBinding,
  name: string,
  handlers: CollabHandlers,
  signal?: AbortSignal,
): Promise<CollabConnection> {
  return openCollab(binding, name, handlers, signal, false);
}

async function openCollab(
  binding: HostBinding,
  name: string,
  handlers: CollabHandlers,
  signal: AbortSignal | undefined,
  welcomeOnly: boolean,
): Promise<CollabConnection> {
  signal?.throwIfAborted();
  const link = parseCollabLink(binding.url);
  if ('error' in link || !link.writeToken) throw new Error('A valid control capability is required');
  const key = await importRoomKey(link.key);
  signal?.throwIfAborted();
  const ws = new WebSocket(`${link.wsUrl}?role=guest`, {
    handshakeTimeout: SETUP_TIMEOUT_MS,
    maxPayload: 0,
    perMessageDeflate: false,
  });
  let closed = false;
  let ready = false;
  let welcomed = false;
  let total = 0;
  let received = 0;
  let sendChain = Promise.resolve();
  let receiveChain = Promise.resolve();
  let resolveSetup!: (connection: CollabConnection) => void;
  let rejectSetup!: (error: unknown) => void;
  const setup = new Promise<CollabConnection>((resolve, reject) => {
    resolveSetup = resolve;
    rejectSetup = reject;
  });
  const timer = setTimeout(() => finish('Collab setup timed out'), SETUP_TIMEOUT_MS);
  const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Collab setup aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });

  function finish(reason: string | Error): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    ws.terminate();
    if (!ready) rejectSetup(signal?.aborted ? signal.reason : reason instanceof Error ? reason : new Error(reason));
    try {
      handlers.onClose(reason instanceof Error ? reason.message : reason);
    } catch {
    }
  }

  function queueSend(frame: GuestFrame): void {
    if (closed || ws.readyState !== WebSocket.OPEN) throw new Error('Collab connection is closed');
    sendChain = sendChain.then(async () => {
      if (closed) return;
      const envelope = packEnvelope(0, await seal(key, frame));
      if (closed) return;
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('Collab transport cannot accept the frame');
      }
      await new Promise<void>((resolve, reject) => {
        ws.send(envelope, error => error ? reject(error) : resolve());
      });
    }).catch(() => finish('Collab send failed; delivery may be uncertain'));
  }

  const connection: CollabConnection = {
    send(frame) {
      if (!ready) throw new Error('Collab snapshot is not ready');
      if (!Object.hasOwn(GUEST_TYPES, frame.t)) throw new Error('Unsupported guest frame');
      queueSend(frame);
    },
    close() {
      finish('closed');
    },
  };

  function deliver(frame: HostFrame): void {
    if (frame.t === 'welcome') {
      if (welcomed || frame.proto !== COLLAB_PROTO || frame.header?.id !== binding.sessionId) {
        throw new Error('Collab session identity mismatch');
      }
      if (frame.readOnly) throw new Error('Collab host refused control access');
      if (!Number.isSafeInteger(frame.entryCount) || frame.entryCount < 0) throw new Error('Invalid Collab snapshot');
      welcomed = true;
      total = frame.entryCount;
    } else if (!welcomed && frame.t === 'snapshot-chunk') {
      throw new Error('Collab snapshot arrived before welcome');
    }
    if (frame.t === 'snapshot-chunk') {
      if (ready || !Array.isArray(frame.entries) || typeof frame.final !== 'boolean') {
        throw new Error('Invalid Collab snapshot chunk');
      }
      received += frame.entries.length;
      if (received > total || (frame.final && received !== total)) throw new Error('Collab snapshot count mismatch');
    }
    handlers.onFrame(frame);
    if (welcomeOnly && frame.t === 'welcome') {
      ready = true;
      resolveSetup(connection);
      finish('closed');
      return;
    }
    if (frame.t === 'bye') {
      finish(frame.reason || 'Collab host ended the room');
      return;
    }
    if (!ready && frame.t === 'error') {
      finish(frame.message);
      return;
    }
    if (!ready && frame.t === 'snapshot-chunk' && frame.final) {
      ready = true;
      clearTimeout(timer);
      resolveSetup(connection);
    }
  }

  ws.on('open', () => {
    try {
      queueSend({
        t: 'hello',
        proto: COLLAB_PROTO,
        name: name.trim().slice(0, 64) || 'Telegram member',
        writeToken: encodeBase64Url(link.writeToken!),
      });
    } catch {
      finish('Collab hello failed');
    }
  });
  ws.on('message', (data, isBinary) => {
    if (closed) return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    if (!isBinary) {
      try {
        const control = JSON.parse(bytes.toString()) as { t?: string };
        if (control.t === 'room-closed') finish('Collab room closed');
      } catch {
        finish('Invalid Collab relay control frame');
      }
      return;
    }
    receiveChain = receiveChain.then(async () => {
      if (closed) return;
      const envelope = unpackEnvelope(bytes);
      if (!envelope) throw new Error('Invalid Collab envelope');
      const frame = await open(key, envelope.payload);
      if (closed) return;
      if (!frame || typeof frame !== 'object' || !Object.hasOwn(HOST_TYPES, frame.t)) throw new Error('Invalid Collab host frame');
      deliver(frame as HostFrame);
    }).catch(error => {
      finish(error instanceof Error ? error.message : 'Collab receive failed');
    });
  });
  ws.on('error', () => finish('Collab transport error'));
  ws.on('close', code => finish(`Collab connection closed (${code})`));
  return setup;
}
