import { COLLAB_PROTO, type SessionState, type GuestFrame, type HostFrame } from '@oh-my-pi/pi-wire';
import WebSocket from 'ws';
import type { CollabConnection, CollabHandlers, HostBinding } from '../shared/contracts.js';
import { importRoomKey, open, seal } from './vendor/codec.js';
import { encodeBase64Url, packEnvelope, parseCollabLink, unpackEnvelope } from './vendor/link.js';

export class CollabTransportError extends Error {}

const SETUP_TIMEOUT_MS = 60_000;
const HOST_TYPES: Record<string, true> = {
  welcome: true, 'snapshot-chunk': true, entry: true, event: true, state: true, bus: true, agents: true,
  'ui-request': true, 'ui-request-end': true, transcript: true, bye: true, error: true,
};
const GUEST_TYPES: Record<string, true> = {
  prompt: true, abort: true, 'agent-cmd': true, 'fetch-transcript': true, 'ui-response': true,
};

type SnapshotFrame = Extract<HostFrame, {t: 'welcome' | 'snapshot-chunk'}>;
type SnapshotOperation = {
  welcomed: boolean;
  total: number;
  received: number;
} & (
  | {kind: 'initial'}
  | {
    kind: 'refresh';
    onFrame: (frame: SnapshotFrame) => void;
    resolve: () => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
    settled: boolean;
  }
);

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
  const writeToken = encodeBase64Url(link.writeToken);
  const key = await importRoomKey(link.key);
  signal?.throwIfAborted();
  const ws = new WebSocket(`${link.wsUrl}?role=guest`, {
    handshakeTimeout: SETUP_TIMEOUT_MS,
    maxPayload: 0,
    perMessageDeflate: false,
  });
  let closed = false;
  let ready = false;
  let snapshot: SnapshotOperation | undefined = {kind: 'initial', welcomed: false, total: 0, received: 0};
  let sendChain = Promise.resolve();
  let receiveChain = Promise.resolve();
  let resolveSetup!: (connection: CollabConnection) => void;
  let rejectSetup!: (error: unknown) => void;
  const setup = new Promise<CollabConnection>((resolve, reject) => {
    resolveSetup = resolve;
    rejectSetup = reject;
  });
  const timer = setTimeout(() => finish(new CollabTransportError('Collab setup timed out')), SETUP_TIMEOUT_MS);
  const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Collab setup aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });

  function finish(reason: string | Error): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (snapshot?.kind === 'refresh') rejectRefresh(snapshot, reason instanceof Error ? reason : new Error(reason));
    ws.terminate();
    if (!ready) rejectSetup(signal?.aborted ? signal.reason : reason instanceof Error ? reason : new Error(reason));
    try {
      handlers.onClose(reason instanceof Error ? reason.message : reason);
    } catch (error) {
      console.error('Collab close callback failed:', error);
    }
  }

  function rejectRefresh(operation: Extract<SnapshotOperation, {kind: 'refresh'}>, error: unknown): void {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    operation.reject(error);
  }

  function sendHello(): void {
    queueSend({
      t: 'hello',
      proto: COLLAB_PROTO,
      name: name.trim().slice(0, 64) || 'Telegram member',
      writeToken,
    });
  }

  function queueSend(frame: GuestFrame): void {
    if (closed || ws.readyState !== WebSocket.OPEN) throw new CollabTransportError('Collab connection is closed');
    sendChain = sendChain.then(async () => {
      if (closed) return;
      const envelope = packEnvelope(0, await seal(key, frame));
      if (closed) return;
      if (ws.readyState !== WebSocket.OPEN) {
        throw new CollabTransportError('Collab transport cannot accept the frame');
      }
      // Only actual send failures get transport classification; encoding failures
      // stay terminal, and recovery must not replay a possibly delivered frame.
      const sent = Promise.withResolvers<void>();
      try {
        ws.send(envelope, error => error
          ? sent.reject(new CollabTransportError(error.message, {cause: error}))
          : sent.resolve());
      } catch (error) {
        throw new CollabTransportError(error instanceof Error ? error.message : String(error), {cause: error});
      }
      await sent.promise;
    }).catch(error => {
      if (closed) return;
      console.error('Collab send failed; delivery may be uncertain:', error);
      finish(error instanceof Error ? error : `Collab send failed; delivery may be uncertain: ${String(error)}`);
    });
  }

  const connection: CollabConnection = {
    send(frame) {
      if (!ready) throw new Error('Collab snapshot is not ready');
      if (!Object.hasOwn(GUEST_TYPES, frame.t)) throw new Error('Unsupported guest frame');
      queueSend(frame);
    },
    async refreshSnapshot(onFrame) {
      if (closed) throw new Error('Collab connection is closed');
      if (!ready) throw new Error('Collab snapshot is not ready');
      if (snapshot) throw new Error('Collab snapshot refresh is already in progress');
      const {promise, resolve, reject} = Promise.withResolvers<void>();
      const operation: Extract<SnapshotOperation, {kind: 'refresh'}> = {
        kind: 'refresh', welcomed: false, total: 0, received: 0, onFrame, resolve, reject, settled: false,
        timer: setTimeout(() => rejectRefresh(operation, new Error('Collab snapshot refresh timed out')), SETUP_TIMEOUT_MS),
      };
      snapshot = operation;
      try {
        sendHello();
      } catch (error) {
        snapshot = undefined;
        rejectRefresh(operation, error);
      }
      return promise;
    },
    close() {
      finish('closed');
    },
  };

  function deliver(frame: HostFrame): void {
    if (frame.t === 'error' && snapshot?.kind === 'refresh' && !snapshot.welcomed &&
        (frame.message === 'Session transition in progress; join again when it completes' ||
         /^protocol mismatch: host speaks v\d+, guest sent v\d+$/.test(frame.message))) {
      const operation = snapshot;
      snapshot = undefined;
      rejectRefresh(operation, new Error(frame.message));
      return;
    }
    if (frame.t === 'welcome' || frame.t === 'snapshot-chunk') {
      const operation = snapshot;
      if (!operation) throw new Error('Unexpected Collab snapshot');
      if (frame.t === 'welcome') {
        if (operation.welcomed || frame.proto !== COLLAB_PROTO || frame.header?.id !== binding.sessionId) {
          throw new Error('Collab session identity mismatch');
        }
        if (frame.readOnly) throw new Error('Collab host refused control access');
        if (!Number.isSafeInteger(frame.entryCount) || frame.entryCount < 0) throw new Error('Invalid Collab snapshot');
        operation.welcomed = true;
        operation.total = frame.entryCount;
      } else {
        if (!operation.welcomed) throw new Error('Collab snapshot arrived before welcome');
        if (!Array.isArray(frame.entries) || typeof frame.final !== 'boolean') {
          throw new Error('Invalid Collab snapshot chunk');
        }
        operation.received += frame.entries.length;
        if (operation.received > operation.total || (frame.final && operation.received !== operation.total)) {
          throw new Error('Collab snapshot count mismatch');
        }
      }
      if (operation.kind === 'refresh') {
        if (!operation.settled) {
          try {
            operation.onFrame(frame);
          } catch (error) {
            rejectRefresh(operation, error);
          }
        }
        if (frame.t === 'snapshot-chunk' && frame.final) {
          snapshot = undefined;
          clearTimeout(operation.timer);
          if (!operation.settled) {
            operation.settled = true;
            operation.resolve();
          }
        }
        return;
      }
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
      snapshot = undefined;
      clearTimeout(timer);
      resolveSetup(connection);
    }
  }

  ws.on('open', () => {
    try {
      sendHello();
    } catch (error) {
      if (closed) return;
      console.error('Collab hello failed:', error);
      finish(error instanceof Error ? error : `Collab hello failed: ${String(error)}`);
    }
  });
  ws.on('message', (data, isBinary) => {
    if (closed) return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    if (!isBinary) {
      try {
        const control = JSON.parse(bytes.toString()) as { t?: string };
        if (control.t === 'room-closed') finish(new CollabTransportError('Collab room closed'));
      } catch (error) {
        console.error('Invalid Collab relay control frame:', error instanceof SyntaxError ? error.name : error);
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
      if (closed) return;
      console.error('Collab receive failed:', error);
      finish(error instanceof Error ? error : new Error(`Collab receive failed: ${String(error)}`, {cause: error}));
    });
  });
  ws.on('error', error => {
    if (closed) return;
    console.error('Collab transport error:', error);
    finish(new CollabTransportError(error.message, {cause: error}));
  });
  ws.on('close', (code, reason) => finish(new CollabTransportError(`Collab connection closed (${code})${reason.length ? `: ${reason.toString()}` : ''}`)));
  return setup;
}
