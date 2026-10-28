import { TelegramError } from 'telegraf';

interface DeliveryJob {
  execute(): Promise<void>;
  active(): boolean;
  cancel(): void;
  reject(error: unknown): void;
}

interface ChatDelivery {
  foreground: DeliveryJob[];
  background: DeliveryJob[];
  nextStartAt: number;
  running: boolean;
}

export class TelegramDelivery {
  private readonly chats = new Map<number, ChatDelivery>();
  private readonly controller = new AbortController();

  constructor(private readonly intervalMs = 3100) {}

  run<T>(chatId: number, action: () => Promise<T>, active: () => boolean, background = false): Promise<T | undefined> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { foreground: [], background: [], nextStartAt: 0, running: false };
      this.chats.set(chatId, chat);
    }
    const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
    const job: DeliveryJob = {
      execute: async () => { resolve(await action()); },
      active,
      cancel: () => resolve(undefined),
      reject,
    };
    (background ? chat.background : chat.foreground).push(job);
    if (!chat.running) {
      chat.running = true;
      void this.drain(chat);
    }
    return promise;
  }

  close(): void {
    this.controller.abort();
    for (const chat of this.chats.values()) {
      for (const job of chat.foreground) job.cancel();
      for (const job of chat.background) job.cancel();
      chat.foreground.length = 0;
      chat.background.length = 0;
    }
    this.chats.clear();
  }

  private wait(ms: number): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    return promise;
  }

  private async drain(chat: ChatDelivery): Promise<void> {
    try {
      while (!this.controller.signal.aborted) {
        const queue = chat.foreground.length ? chat.foreground : chat.background;
        const job = queue[0];
        if (!job) return;
        try {
          if (!job.active()) {
            queue.shift();
            job.cancel();
            continue;
          }
        } catch (error) {
          queue.shift();
          job.reject(error);
          continue;
        }
        const wait = chat.nextStartAt - Date.now();
        if (wait > 0) {
          await this.wait(wait);
          continue;
        }
        queue.shift();
        chat.nextStartAt = Date.now() + this.intervalMs;
        try {
          await job.execute();
        } catch (error) {
          if (error instanceof TelegramError && error.code === 429) {
            if (this.controller.signal.aborted) {
              job.cancel();
            } else {
              const retryMs = Math.max(0, error.parameters?.retry_after ?? 5) * 1000;
              chat.nextStartAt = Math.max(chat.nextStartAt, Date.now() + retryMs);
              queue.unshift(job);
            }
          } else {
            job.reject(error);
          }
        }
      }
    } finally {
      chat.running = false;
    }
  }
}
