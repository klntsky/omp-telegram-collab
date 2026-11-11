import { channel } from 'node:diagnostics_channel';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { GuestFrame, HostFrame } from '@oh-my-pi/pi-wire';
import type { Omp } from '../../../src/omp.js';

export function observeApplicationLogs(log: (event: string, data: unknown) => void): () => void {
  const logs = channel('omp-telegram.log');
  const observe = (record: unknown) => { log('application.log', JSON.parse(String(record))); };
  logs.subscribe(observe);
  return () => { logs.unsubscribe(observe); };
}

// Observation owns no application lifecycle; the fixture supplies its wake-up barrier.
export function createCollaborationObserver(options: {
  token: string;
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
        const connection = await connect(binding, name, {
          onFrame(frame) {
            hostFrames.push(frame);
            log('collab.host.frame', frame);
            handlers.onFrame(frame);
            notify();
          },
          onClose(reason) {
            log('collab.close', { reason });
            handlers.onClose(reason);
          },
        }, signal);
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
          close() { connection.close(); },
        };
      } catch (error) {
        log('collab.connect.error', { error });
        throw error;
      }
    };
  }
  return { createBot, instrumentRuntime };
}
