import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { GuestFrame, HostFrame } from '@oh-my-pi/pi-wire';
import type { Omp } from '../../../src/omp.js';
import type { CollabConnection } from '../../../shared/contracts.js';
import { bounded } from './async.js';

// The fixture owns application lifetime; this helper observes and interrupts real transports.
export function createCollaborationObserver(options: {
  token: string;
  signal: AbortSignal;
  chatId: number;
  log(event: string, data: unknown): void;
  notify(): void;
  apiCalls: { method: string; payload: unknown; result: unknown }[];
  updates: Update[];
  handledMessages: Set<number>;
  hostFrames: HostFrame[];
  guestFrames: GuestFrame[];
}) {
  const { log, notify, apiCalls, updates, handledMessages, hostFrames, guestFrames } = options;
  const connections = new Set<CollabConnection>();
  let resumeConnections: PromiseWithResolvers<void> | undefined;
  let interruptPrompt: PromiseWithResolvers<() => void> | undefined;
  function interruptNextPromptReceipt(): Promise<() => void> {
    if (interruptPrompt) throw new Error('A prompt receipt interruption is already armed');
    interruptPrompt = Promise.withResolvers<() => void>();
    return interruptPrompt.promise;
  }
  function disconnectGuests(): () => void {
    // Close actual Collab transports, so the real close handlers drive recovery.
    // Admission waits rather than fabricating a failed connection or host frame.
    const barrier = resumeConnections ??= Promise.withResolvers<void>();
    for (const connection of connections) connection.close();
    connections.clear();
    return () => {
      if (resumeConnections === barrier) resumeConnections = undefined;
      barrier.resolve();
    };
  }
  function createBot() {
    const value = new Bot(options.token, { client: { environment: 'test' } });
    value.api.config.use(async (previous, method, payload, signal) => {
      log('telegram.api.request', { method, payload });
      try {
        const result = await previous(method, payload, signal);
        apiCalls.push({ method, payload, result });
        notify();
        log('telegram.api.result', { method, result });
        return result;
      } catch (error) {
        log('telegram.api.error', { method, error });
        throw error;
      }
    });
    value.use(async (ctx, next) => {
      updates.push(ctx.update);
      log('telegram.update', ctx.update);
      await next();
      if (ctx.chat?.id === options.chatId && ctx.message) {
        handledMessages.add(ctx.message.message_id);
        notify();
      }
    });
    return value;
  }
  function instrumentRuntime(value: Omp): void {
    const connect = value.connectCollab.bind(value);
    value.connectCollab = async (binding, name, handlers, signal) => {
      try {
        while (resumeConnections) {
          await bounded(resumeConnections.promise, signal
            ? AbortSignal.any([signal, options.signal]) : options.signal);
        }
        let owned: CollabConnection | undefined;
        const connection = await connect(binding, name, {
          onFrame(frame) {
            hostFrames.push(frame);
            log('collab.host.frame', frame);
            if (interruptPrompt && frame.t === 'entry' &&
                frame.entry.type === 'custom_message' && frame.entry.customType === 'collab-prompt') {
              const interrupted = interruptPrompt;
              interruptPrompt = undefined;
              interrupted.resolve(disconnectGuests());
              notify();
              return;
            }
            handlers.onFrame(frame);
            notify();
          },
          onClose(reason) {
            if (owned) connections.delete(owned);
            log('collab.close', { reason });
            handlers.onClose(reason);
          },
        }, signal);
        owned = connection;
        connections.add(connection);
        return {
          send(frame) {
            guestFrames.push(frame);
            log('collab.guest.frame', frame);
            try { connection.send(frame); } catch (error) {
              log('collab.send.error', { error });
              throw error;
            }
          },
          refreshSnapshot(onFrame) { return connection.refreshSnapshot(onFrame); },
          close() { connections.delete(connection); connection.close(); },
        };
      } catch (error) {
        log('collab.connect.error', { error });
        throw error;
      }
    };
  }
  return { createBot, instrumentRuntime, disconnectGuests, interruptNextPromptReceipt };
}
