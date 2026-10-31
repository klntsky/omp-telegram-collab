import { GrammyError } from 'grammy';
import {
  AbortController as TelegramAbortController,
  type AbortSignal as TelegramAbortSignal,
} from 'abort-controller';
import { withTelegramDeliveryRetry } from './telegram-retry.js';

type LaneName = 'ordinary' | 'name' | 'icon';

interface DeliveryJob {
  execute(): Promise<void>;
  active(): boolean;
  cancel(): void;
  reject(error: unknown): void;
  abort?: () => void;
}

interface DeliveryLane {
  pending: Map<string, DeliveryJob>;
  running?: DeliveryJob;
}

interface TypingJob extends DeliveryJob {
  expiresAt: number;
}

interface TypingTopic {
  active(): boolean;
  refreshedAt: number;
  nextStartAt: number;
  visibleUntil: number;
  pending?: TypingJob;
}

interface ChatDelivery {
  lanes: Record<LaneName, DeliveryLane>;
  ordinary: DeliveryJob[];
  typingRunning?: TypingJob;
  topics: Map<number, TypingTopic>;
  nextStartAt: number;
  timer?: NodeJS.Timeout;
  pumpQueued: boolean;
}

const laneNames: readonly LaneName[] = ['ordinary', 'name', 'icon'];

// Eligibility callbacks are pure state queries. Scheduling runs in a coalesced microtask.
export class TelegramDelivery {
  private readonly chats = new Map<number, ChatDelivery>();
  private closed = false;

  run<T>(chatId: number, action: () => Promise<T>, active: () => boolean): Promise<T | undefined> {
    return this.enqueue(chatId, 'ordinary', undefined, action, active);
  }

  runTopic<T>(
    chatId: number,
    field: 'name' | 'icon',
    key: string,
    action: (signal: TelegramAbortSignal) => Promise<T>,
    active: () => boolean,
  ): Promise<T | undefined> {
    return this.enqueue(chatId, field, key, action, active);
  }

  typing(
    chatId: number,
    threadId: number,
    action: () => Promise<unknown>,
    active: () => boolean,
  ): Promise<void | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const chat = this.getChat(chatId);
    const now = Date.now();
    this.expireTyping(chat, now);
    try {
      if (!active()) return Promise.resolve(undefined);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.closed) return Promise.resolve(undefined);
    let topic = chat.topics.get(threadId);
    if (!topic) {
      if (chat.topics.size >= 3) return Promise.resolve(undefined);
      topic = {
        active,
        refreshedAt: now,
        nextStartAt: 0,
        visibleUntil: 0,
      };
      chat.topics.set(threadId, topic);
    } else {
      topic.active = active;
      topic.refreshedAt = now;
    }
    this.invalidateTyping(chatId, threadId);
    const { promise, resolve, reject } = Promise.withResolvers<void | undefined>();
    const remove = () => {
      if (topic.pending === job) topic.pending = undefined;
    };
    const job: TypingJob = {
      expiresAt: now + 4000,
      execute: async () => {
        topic.nextStartAt = Date.now() + 4000;
        topic.visibleUntil = Date.now() + 5000;
        resolve(
          await withTelegramDeliveryRetry(async () => {
            await action();
          }),
        );
      },
      active,
      cancel: () => {
        remove();
        resolve(undefined);
      },
      reject: (error) => {
        remove();
        reject(error);
      },
    };
    topic.pending = job;
    chat.topics.delete(threadId);
    chat.topics.set(threadId, topic);
    this.admit(chat);
    return promise;
  }

  invalidateTyping(chatId: number, threadId: number): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    chat.topics.get(threadId)?.pending?.cancel();
    this.admit(chat);
  }

  close(): void {
    this.closed = true;
    for (const chat of this.chats.values()) {
      clearTimeout(chat.timer);
      for (const job of chat.ordinary) {
        if (job !== chat.lanes.ordinary.running) job.cancel();
      }
      chat.ordinary.length = 0;
      for (const name of laneNames) {
        const lane = chat.lanes[name];
        for (const job of lane.pending.values()) job.cancel();
        lane.pending.clear();
        lane.running?.abort?.();
      }
      for (const topic of chat.topics.values()) topic.pending?.cancel();
      chat.topics.clear();
    }
    this.chats.clear();
  }

  private getChat(chatId: number): ChatDelivery {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        lanes: {
          ordinary: { pending: new Map() },
          name: { pending: new Map() },
          icon: { pending: new Map() },
        },
        ordinary: [],
        topics: new Map(),
        nextStartAt: 0,
        pumpQueued: false,
      };
      this.chats.set(chatId, chat);
    }
    return chat;
  }

  private enqueue<T>(
    chatId: number,
    name: LaneName,
    key: string | undefined,
    action: (signal: TelegramAbortSignal) => Promise<T>,
    active: () => boolean,
  ): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const chat = this.getChat(chatId);
    const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
    const job: DeliveryJob = {
      active,
      cancel: () => resolve(undefined),
      reject,
      execute: async () => {
        if (name === 'ordinary') {
          resolve(await (action as () => Promise<T>)());
          return;
        }
        const controller = new TelegramAbortController();
        const finished = Promise.withResolvers<T | undefined>();
        let settled = false;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          job.abort = undefined;
          outcome();
        };
        const timer = setTimeout(() => {
          finish(() =>
            finished.reject(new Error('Telegram topic delivery timed out after 5000ms')),
          );
          controller.abort();
        }, 5000);
        job.abort = () => {
          finish(() => finished.resolve(undefined));
          controller.abort();
        };
        try {
          const raw = action(controller.signal);
          void raw.then(
            (value) => finish(() => finished.resolve(value)),
            (error) => {
              this.observeRateLimit(chat, error);
              finish(() => finished.reject(error));
            },
          );
        } catch (error) {
          this.observeRateLimit(chat, error);
          finish(() => finished.reject(error));
        }
        resolve(await finished.promise);
      },
    };
    if (name === 'ordinary') chat.ordinary.push(job);
    else {
      const lane = chat.lanes[name];
      lane.pending.get(key!)?.cancel();
      lane.pending.set(key!, job);
    }
    this.admit(chat);
    return promise;
  }

  private observeRateLimit(chat: ChatDelivery, error: unknown): boolean {
    if (!(error instanceof GrammyError) || error.error_code !== 429) return false;
    const retryMs = Math.max(0, error.parameters?.retry_after ?? 5) * 1000;
    chat.nextStartAt = Math.max(chat.nextStartAt, Date.now() + retryMs);
    if (!this.closed) this.admit(chat);
    return true;
  }

  private admit(chat: ChatDelivery): void {
    if (this.closed || chat.pumpQueued) return;
    chat.pumpQueued = true;
    queueMicrotask(() => {
      chat.pumpQueued = false;
      if (!this.closed) this.pump(chat);
    });
  }

  private expireTyping(chat: ChatDelivery, now: number): void {
    for (const [id, topic] of chat.topics) {
      if (topic.pending && topic.pending.expiresAt <= now) topic.pending.cancel();
      if (topic.visibleUntil > now) continue;
      try {
        if (topic.active() && now - topic.refreshedAt < 4000) continue;
      } catch (error) {
        topic.pending?.reject(error);
      }
      topic.pending?.cancel();
      chat.topics.delete(id);
    }
  }

  private pump(chat: ChatDelivery): void {
    clearTimeout(chat.timer);
    chat.timer = undefined;
    const now = Date.now();
    this.expireTyping(chat, now);
    let wakeAt = Infinity;
    for (const topic of chat.topics.values()) {
      if (topic.pending) wakeAt = Math.min(wakeAt, topic.pending.expiresAt);
    }
    for (const name of laneNames) {
      const lane = chat.lanes[name];
      if (lane.running) continue;
      while (true) {
        const entry = name === 'ordinary' ? undefined : lane.pending.entries().next().value;
        const job = name === 'ordinary' ? chat.ordinary[0] : entry?.[1];
        if (!job) break;
        const remove = () => {
          if (name === 'ordinary') chat.ordinary.shift();
          else lane.pending.delete(entry![0]);
        };
        let active: boolean;
        try {
          active = job.active();
        } catch (error) {
          remove();
          job.reject(error);
          continue;
        }
        if (!active) {
          remove();
          job.cancel();
          continue;
        }
        if (chat.nextStartAt > now) {
          wakeAt = Math.min(wakeAt, chat.nextStartAt);
          break;
        }
        if (name !== 'ordinary') remove();
        lane.running = job;
        let retry = false;
        void withTelegramDeliveryRetry(job.execute)
          .catch((error) => {
            if (name === 'ordinary' && this.observeRateLimit(chat, error)) {
              retry = !this.closed;
              if (this.closed) job.cancel();
            } else job.reject(error);
          })
          .finally(() => {
            if (retry && this.closed) job.cancel();
            if (name === 'ordinary' && !retry && chat.ordinary[0] === job)
              chat.ordinary.shift();
            lane.running = undefined;
            this.admit(chat);
          });
        break;
      }
    }
    const realBusy =
      chat.ordinary.length > 0 ||
      laneNames.some((name) => chat.lanes[name].running || chat.lanes[name].pending.size);
    if (!chat.typingRunning && !realBusy) {
      let ready: TypingTopic | undefined;
      for (const topic of chat.topics.values()) {
        const job = topic.pending;
        if (!job) continue;
        try {
          if (!job.active()) {
            job.cancel();
            continue;
          }
        } catch (error) {
          job.reject(error);
          continue;
        }
        const startsAt = Math.max(chat.nextStartAt, topic.nextStartAt);
        if (startsAt > now) wakeAt = Math.min(wakeAt, startsAt);
        else if (!ready || topic.nextStartAt < ready.nextStartAt) ready = topic;
      }
      if (ready) {
        const job = ready.pending!;
        ready.pending = undefined;
        chat.typingRunning = job;
        void job.execute()
          .catch((error) => {
            this.observeRateLimit(chat, error);
            job.reject(error);
          })
          .finally(() => {
            chat.typingRunning = undefined;
            this.admit(chat);
          });
      }
    }
    if (Number.isFinite(wakeAt))
      chat.timer = setTimeout(() => this.admit(chat), Math.max(0, wakeAt - Date.now()));
  }
}
