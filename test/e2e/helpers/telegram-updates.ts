import TelegramAbortController from 'abort-controller';
import type { Api } from 'grammy';
import type { Update } from 'grammy/types';
import { combineTelegramErrors } from './errors.js';

export class TelegramTestInbox {
  readonly #api: Api;
  readonly #signal: AbortSignal;
  #offset = 0;
  #pending: Update[] = [];
  #waiting = false;

  constructor(api: Api, signal: AbortSignal) {
    this.#api = api;
    this.#signal = signal;
  }

  async waitFor(matches: (update: Update) => boolean, options: { timeoutMs?: number } = {}): Promise<Update> {
    if (this.#waiting) throw new Error('Only one Telegram update wait may run per bot inbox');
    const signal = AbortSignal.any([this.#signal, AbortSignal.timeout(options.timeoutMs ?? 30000)]);
    const telegram = new TelegramAbortController();
    const abort = () => telegram.abort();
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    this.#waiting = true;
    try {
      for (;;) {
        signal.throwIfAborted();
        const found = this.#pending.findIndex(matches);
        if (found !== -1) return this.#pending.splice(found, 1)[0]!;
        const updates = await this.#api.getUpdates({ offset: this.#offset, timeout: 5, allowed_updates: ['message'] }, telegram.signal);
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          this.#pending.push(update);
        }
      }
    } catch (error) {
      if (signal.aborted && error !== signal.reason) throw combineTelegramErrors(signal.reason, error);
      throw error;
    } finally {
      this.#waiting = false;
      signal.removeEventListener('abort', abort);
    }
  }
}
