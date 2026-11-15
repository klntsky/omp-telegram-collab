import type { CollabConnection } from '../shared/contracts.js';
import type { HistoryWatch, HistoryCheckpoint, HistorySource } from './history-watch.js';
import type { Omp } from './omp.js';
import { SessionFeed } from './session-feed.js';
import { HistoryClosedError, HistorySourceError, HistoryStateError } from './history-errors.js';
import { CollabSnapshotError, CollabTransportError } from './collab.js';
import { SessionFeedError } from './session-feed-errors.js';

export interface SessionHistoryOptions {
  sessionId: string;
  source(): Promise<HistorySource | undefined>;
  watch: Omp['watchHistory'];
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
    if (this.closed) throw new HistoryClosedError(`Session history is closed for session ${this.options.sessionId}`);
    this.options.assertActive();
  }

  private async openWatch(): Promise<HistoryWatch> {
    const source = await this.options.source();
    this.assertActive();
    if (!source || source.sessionId !== this.options.sessionId) throw new HistorySourceError(`Managed OMP history source is unavailable for session ${this.options.sessionId}`);
    const watch = await this.options.watch(source, {
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
    catch (error) {
      try { await watch.close(); }
      catch (cleanupError) { console.error(`Close history watcher for session ${this.options.sessionId}:`, cleanupError); }
      throw error;
    }
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
      if (!(error instanceof HistorySourceError) && !(error instanceof HistoryStateError)) throw error;
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
        if (!(error instanceof HistorySourceError) && !(error instanceof HistoryStateError)) throw error;
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
      // refreshOnce reports its rejection through fail before this scheduled observer consumes it.
      void this.ensureFresh().catch(error => {
        if (!(error instanceof HistoryClosedError)) console.error(`Refresh scheduled history for session ${this.options.sessionId}:`, error);
      });
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
      if (!this.connection) throw new HistoryStateError(`Refresh history for session ${this.options.sessionId}: Session not connected`);
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
      throw new HistorySourceError(`Session history changed repeatedly while refreshing session ${this.options.sessionId}`);
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
    if (this.closed && error instanceof HistoryClosedError) return;
    console.error(`Session history failed for session ${this.options.sessionId}:`, error);
    if (this.closed) return;
    this.feed.discardHistoryRefresh();
    if (error instanceof HistorySourceError || error instanceof HistoryStateError || error instanceof CollabSnapshotError || error instanceof CollabTransportError || error instanceof SessionFeedError)
      this.feed.reportHistoryError(error);
    this.options.onError(error);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pendingChange = false;
    this.feed.discardHistoryRefresh();
    this.closing = (async () => {
      await this.watch?.close();
      // The refresh task reports through fail; closing still waits for its completion.
      await this.refreshing?.then(() => undefined, () => undefined);
    })();
    return this.closing;
  }
}
