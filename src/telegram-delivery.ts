import { GrammyError } from 'grammy';
import { AbortController as TelegramAbortController, type AbortSignal as TelegramAbortSignal } from 'abort-controller';

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

interface ChatDelivery {
  lanes: Record<LaneName, DeliveryLane>;
  nextStartAt: number;
  timer?: NodeJS.Timeout;
  admission: { kind: 'idle' } | { kind: 'running'; requested: boolean };
}

const laneNames: readonly LaneName[] = ['ordinary', 'name', 'icon'];

export class TelegramDelivery {
  private readonly chats = new Map<number, ChatDelivery>();
  private closed = false;
  private sequence = 0;

  run<T>(chatId: number, action: () => Promise<T>, active: () => boolean): Promise<T | undefined> {
    return this.enqueue(chatId, 'ordinary', String(this.sequence++), action, active);
  }

  runTopic<T>(chatId: number, field: 'name' | 'icon', key: string, action: (signal: TelegramAbortSignal) => Promise<T>, active: () => boolean): Promise<T | undefined> {
    return this.enqueue(chatId, field, key, action, active);
  }

  close(): void {
    this.closed = true;
    for (const chat of this.chats.values()) {
      clearTimeout(chat.timer);
      for (const name of laneNames) {
        const lane = chat.lanes[name];
        for (const job of lane.pending.values()) job.cancel();
        lane.pending.clear();
        lane.running?.abort?.();
      }
    }
    this.chats.clear();
  }

  private enqueue<T>(chatId: number, name: LaneName, key: string, action: (signal: TelegramAbortSignal) => Promise<T>, active: () => boolean): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        lanes: { ordinary: { pending: new Map() }, name: { pending: new Map() }, icon: { pending: new Map() } },
        nextStartAt: 0,
        admission: {kind:'idle'},
      };
      this.chats.set(chatId, chat);
    }
    const owner = chat;
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
          finish(() => finished.reject(new Error('Telegram topic delivery timed out after 5000ms')));
          controller.abort();
        }, 5000);
        job.abort = () => {
          finish(() => finished.resolve(undefined));
          controller.abort();
        };
        try {
          const raw = action(controller.signal);
          void raw.then(
            value => finish(() => finished.resolve(value)),
            error => {
              this.observeRateLimit(owner, error);
              finish(() => finished.reject(error));
            },
          );
        } catch (error) {
          this.observeRateLimit(owner, error);
          finish(() => finished.reject(error));
        }
        resolve(await finished.promise);
      },
    };
    const lane = chat.lanes[name];
    lane.pending.get(key)?.cancel();
    lane.pending.set(key, job);
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
    if (this.closed) return;
    if (chat.admission.kind === 'running') {
      chat.admission.requested = true;
      return;
    }
    const pass: {kind:'running';requested:boolean} = {kind:'running',requested:false};
    chat.admission = pass;
    clearTimeout(chat.timer);
    chat.timer = undefined;
    try {
      for (const name of laneNames) {
        const lane = chat.lanes[name];
        if (lane.running) continue;
        for (const [key, job] of lane.pending) {
          let active: boolean;
          try {
            active = job.active();
          } catch (error) {
            if (lane.pending.get(key) === job) lane.pending.delete(key);
            job.reject(error);
            continue;
          }
          if (lane.pending.get(key) !== job) continue;
          if (!active) {
            lane.pending.delete(key);
            job.cancel();
            continue;
          }
          if (this.closed) return;
          const wait = chat.nextStartAt - Date.now();
          if (wait > 0) {
            chat.timer = setTimeout(() => this.admit(chat), wait);
            return;
          }
          lane.pending.delete(key);
          lane.running = job;
          void job.execute().catch(error => {
            if (name === 'ordinary' && this.observeRateLimit(chat, error)) {
              if (this.closed) job.cancel();
              else lane.pending = new Map([[key, job], ...lane.pending]);
            } else {
              job.reject(error);
            }
          }).finally(() => {
            lane.running = undefined;
            this.admit(chat);
          });
          break;
        }
      }
    } finally {
      chat.admission = {kind:'idle'};
      if (pass.requested && !this.closed && chat.timer === undefined) queueMicrotask(() => this.admit(chat));
    }
  }
}
