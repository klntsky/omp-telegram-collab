import type { CollabConnection } from '../shared/contracts.js';
import { HistoryWatch, type HistoryCheckpoint, type HistorySource } from './history-watch.js';
import { SessionFeed } from './session-feed.js';

export interface SessionHistoryOptions {
  sessionId: string;
  source(): Promise<HistorySource | undefined>;
  assertActive(): void;
  onError(error: unknown): void;
}

export class SessionHistory {
  private watch: HistoryWatch | undefined;
  private initial: HistoryCheckpoint | undefined;
  private connection: CollabConnection | undefined;
  private refreshing: Promise<void> | undefined;
  private pendingChange = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(readonly feed: SessionFeed, private readonly options: SessionHistoryOptions) {}

  private assertActive(): void {
    if (this.closed) throw new Error('Session history is closed');
    this.options.assertActive();
  }

  private async openWatch(): Promise<HistoryWatch> {
    const source = await this.options.source();
    this.assertActive();
    if (!source || source.sessionId !== this.options.sessionId) throw new Error('Managed OMP history source is unavailable');
    const watch = await HistoryWatch.open(source, {
      pollIntervalMs: 5_000,
      onChange: state => {
        if (this.closed) return;
        this.pendingChange = true;
        this.feed.invalidateHistory();
        if (state.state === 'unverified') this.feed.reportHistoryError(state.error);
        this.scheduleRefresh();
      },
    });
    try { this.assertActive(); }
    catch (error) { await watch.close(); throw error; }
    this.watch = watch;
    return watch;
  }

  async prepare(): Promise<void> {
    try {
      const watch = this.watch ?? await this.openWatch();
      this.initial = await watch.capture();
      this.assertActive();
    } catch (error) {
      this.fail(error);
    }
  }

  async start(connection: CollabConnection): Promise<void> {
    this.assertActive();
    this.connection = connection;
    const checkpoint = this.initial;
    this.initial = undefined;
    if (this.watch && checkpoint) {
      try {
        if (await this.watch.accept(checkpoint)) this.feed.confirmInitialHistory();
        else this.feed.invalidateHistory();
      } catch (error) {
        this.fail(error);
      } finally {
        await this.watch.discard(checkpoint);
      }
    }
    this.assertActive();
    if (!this.feed.historyFresh) this.pendingChange = true;
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (!this.connection || this.closed || this.refreshing || !this.pendingChange) return;
    queueMicrotask(() => {
      if (!this.connection || this.closed || this.refreshing || !this.pendingChange) return;
      void this.ensureFresh().catch(() => {});
    });
  }

  async ensureFresh(): Promise<void> {
    do {
      await this.refreshOnce();
      this.assertActive();
    } while (!this.feed.historyFresh);
  }

  private refreshOnce(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const task = (async () => {
      this.assertActive();
      this.pendingChange = false;
      const watch = this.watch ?? await this.openWatch();
      const state = await watch.check();
      this.assertActive();
      if (state.state === 'clean' && this.feed.historyFresh) return;
      this.feed.invalidateHistory();
      if (state.state === 'unverified') throw state.error;
      if (!this.connection) throw new Error('Session not connected');
      for (let attempt = 0; attempt < 2; attempt++) {
        this.pendingChange = false;
        const checkpoint = await watch.capture();
        try {
          this.assertActive();
          await this.connection.refreshSnapshot(this.feed.beginHistoryRefresh());
          this.assertActive();
          const accepted = await watch.accept(checkpoint);
          this.assertActive();
          if (accepted) {
            this.feed.finishHistoryRefresh();
            return;
          }
          this.feed.discardHistoryRefresh();
          const current = await watch.check();
          this.assertActive();
          if (current.state === 'unverified') throw current.error;
        } finally {
          await watch.discard(checkpoint);
        }
      }
      throw new Error('Session history changed repeatedly while refreshing');
    })().catch(error => {
      this.fail(error);
      throw error;
    }).finally(() => {
      if (this.refreshing === task) this.refreshing = undefined;
      this.scheduleRefresh();
    });
    this.refreshing = task;
    return task;
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.feed.discardHistoryRefresh(error);
    this.options.onError(error);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pendingChange = false;
    this.feed.discardHistoryRefresh();
    this.closing = (async () => {
      await this.watch?.close();
      await this.refreshing?.catch(() => {});
    })();
    return this.closing;
  }
}
