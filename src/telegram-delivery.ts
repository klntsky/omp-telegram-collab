import { GrammyError } from 'grammy';
import { withTelegramDeliveryRetry } from './telegram-retry.js';

interface DeliveryJob {
  execute(): Promise<void>;
  active(): boolean;
  cancel(): void;
  reject(error: unknown): void;
}

interface TypingJob extends DeliveryJob {
  threadId: number;
  expiresAt: number;
}

interface TypingTopic {
  active(): boolean;
  refreshedAt: number;
  nextStartAt: number;
  visibleUntil: number;
}

interface ChatDelivery {
  foreground: DeliveryJob[];
  background: DeliveryJob[];
  typing: TypingJob[];
  topics: Map<number, TypingTopic>;
  typingStarts: Map<number, number>;
  wake?: () => void;
  nextStartAt: number;
  running: boolean;
}

export class TelegramDelivery {
  private readonly chats = new Map<number, ChatDelivery>();
  private readonly controller = new AbortController();

  run<T>(chatId: number, action: () => Promise<T>, active: () => boolean, background = false): Promise<T | undefined> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { foreground: [], background: [], typing: [], topics: new Map(), typingStarts: new Map(), nextStartAt: 0, running: false };
      this.chats.set(chatId, chat);
    }
    const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
    const job: DeliveryJob = {
      execute: async () => { resolve(await withTelegramDeliveryRetry(action)); },
      active,
      cancel: () => resolve(undefined),
      reject,
    };
    (background ? chat.background : chat.foreground).push(job);
    chat.wake?.();
    if (!chat.running) {
      chat.running = true;
      void this.drain(chat);
    }
    return promise;
  }

  typing(chatId: number, threadId: number, action: () => Promise<unknown>, active: () => boolean): Promise<void | undefined> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { foreground: [], background: [], typing: [], topics: new Map(), typingStarts: new Map(), nextStartAt: 0, running: false };
      this.chats.set(chatId, chat);
    }
    const now = Date.now();
    for (const [id, nextStartAt] of chat.typingStarts) {
      if (nextStartAt <= now) chat.typingStarts.delete(id);
    }
    for (const [id, topic] of chat.topics) {
      try {
        if (topic.visibleUntil > now || topic.active() && now - topic.refreshedAt < 4000) continue;
      } catch (error) {
        for (const job of chat.typing.filter(job => job.threadId === id)) job.reject(error);
      }
      this.invalidateTyping(chatId, id);
      chat.topics.delete(id);
    }
    try {
      if (!active()) return Promise.resolve(undefined);
    } catch (error) {
      return Promise.reject(error);
    }
    let topic = chat.topics.get(threadId);
    if (!topic) {
      if (chat.topics.size >= 3) return Promise.resolve(undefined);
      topic = { active, refreshedAt: now, nextStartAt: chat.typingStarts.get(threadId) ?? 0, visibleUntil: 0 };
      chat.topics.set(threadId, topic);
    } else {
      topic.active = active;
      topic.refreshedAt = now;
    }
    this.invalidateTyping(chatId, threadId);
    const { promise, resolve, reject } = Promise.withResolvers<void | undefined>();
    const queue = chat.typing;
    let timer: NodeJS.Timeout;
    const remove = () => {
      clearTimeout(timer);
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    };
    const job: TypingJob = {
      threadId,
      expiresAt: now + 4000,
      execute: async () => {
        clearTimeout(timer);
        topic.nextStartAt = Date.now() + 4000;
        topic.visibleUntil = Date.now() + 5000;
        chat.typingStarts.set(threadId, topic.nextStartAt);
        resolve(await withTelegramDeliveryRetry(async () => { await action(); }));
      },
      active,
      cancel: () => { remove(); resolve(undefined); },
      reject: error => { remove(); reject(error); },
    };
    timer = setTimeout(() => { job.cancel(); chat.wake?.(); }, 4000);
    queue.push(job);
    chat.wake?.();
    if (!chat.running) {
      chat.running = true;
      void this.drain(chat);
    }
    return promise;
  }

  invalidateTyping(chatId: number, threadId: number): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    for (const job of [...chat.typing]) {
      if (job.threadId === threadId) job.cancel();
    }
    chat.wake?.();
  }

  close(): void {
    this.controller.abort();
    for (const chat of this.chats.values()) {
      for (const job of chat.foreground) job.cancel();
      for (const job of chat.background) job.cancel();
      for (const job of [...chat.typing]) job.cancel();
      chat.topics.clear();
      chat.wake?.();
      chat.foreground.length = 0;
      chat.background.length = 0;
    }
    this.chats.clear();
  }

  private wait(ms: number, chat: ChatDelivery): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      if (chat.wake === done) chat.wake = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    chat.wake = done;
    signal.addEventListener('abort', done, { once: true });
    return promise;
  }

  private async drain(chat: ChatDelivery): Promise<void> {
    try {
      while (!this.controller.signal.aborted) {
        chat.typing.sort((a, b) =>
          (chat.topics.get(a.threadId)?.nextStartAt ?? 0) - (chat.topics.get(b.threadId)?.nextStartAt ?? 0));
        const queue: DeliveryJob[] = chat.foreground.length ? chat.foreground : chat.background.length ? chat.background : chat.typing;
        const job = queue[0];
        if (!job) return;
        const typing = queue === chat.typing ? job as TypingJob : undefined;
        if (typing && typing.expiresAt <= Date.now()) {
          typing.cancel();
          continue;
        }
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
        const nextStartAt = typing
          ? Math.max(chat.nextStartAt, chat.topics.get(typing.threadId)?.nextStartAt ?? 0)
          : chat.nextStartAt;
        const wait = nextStartAt - Date.now();
        if (wait > 0) {
          await this.wait(typing ? Math.min(wait, typing.expiresAt - Date.now()) : wait, chat);
          continue;
        }
        queue.shift();
        try {
          await job.execute();
        } catch (error) {
          if (error instanceof GrammyError && error.error_code === 429) {
            if (this.controller.signal.aborted) {
              job.cancel();
            } else {
              const retryMs = Math.max(0, error.parameters?.retry_after ?? 5) * 1000;
              chat.nextStartAt = Math.max(chat.nextStartAt, Date.now() + retryMs);
              if (typing) job.reject(error);
              else queue.unshift(job);
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
