import { watch, type BigIntStats, type FSWatcher } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { HistoryClosedError, HistorySourceError, HistoryStateError, historyOperation } from './history-errors.js';

export interface HistorySource { sessionId: string; path: string }
export type HistoryFreshness = { state: 'clean' } | { state: 'dirty' } | { state: 'unverified'; error: unknown };
declare const checkpointBrand: unique symbol;
export interface HistoryCheckpoint { readonly [checkpointBrand]: true }
export interface HistoryWatchOptions {
  onChange?: (state: Exclude<HistoryFreshness, { state: 'clean' }>) => void;
  pollIntervalMs?: number;
}

interface Sample { canonical: string; metadata: BigIntStats }
interface Pin { handle: FileHandle; sample: Sample }
interface Capture { pin: Pin; revision: number }

function rewritten(previous: Sample, current: Sample): boolean {
  if (previous.canonical !== current.canonical || previous.metadata.dev !== current.metadata.dev ||
      previous.metadata.ino !== current.metadata.ino || current.metadata.size < previous.metadata.size) return true;
  return current.metadata.size === previous.metadata.size &&
    (current.metadata.mtimeNs !== previous.metadata.mtimeNs || current.metadata.ctimeNs !== previous.metadata.ctimeNs);
}

function diagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${'code' in error ? String(error.code) : ''}\n${error.message}`;
}

export async function readHistoryHeader(handle: FileHandle, source: string): Promise<{ id: string; cwd: string }> {
  const buffer = Buffer.alloc(64 * 1024);
  const { bytesRead } = await historyOperation(`Read OMP history header ${source}`, () => handle.read(buffer, 0, buffer.byteLength, 0));
  const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0] || '{}') as Record<string, unknown>;
    if (header?.type === 'title' && header.v === 1) header = JSON.parse(lines[1] || '{}') as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HistorySourceError(`Parse OMP history header ${source}: ${error.message}`, {cause: error});
  }
  if (!header || header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string') {
    throw new HistorySourceError(`Read OMP history header ${source}: Unsupported managed OMP session history format`);
  }
  return { id: header.id, cwd: header.cwd };
}

export class HistoryWatch {
  readonly #source: HistorySource;
  readonly #options: HistoryWatchOptions;
  readonly #handles = new Set<FileHandle>();
  readonly #captures = new Map<HistoryCheckpoint, Capture>();
  #baseline?: Pin;
  #observed?: Sample;
  #dirty = true;
  #error?: { error: unknown; diagnostic: string };
  #revision = 0;
  #watcher?: FSWatcher;
  #directory?: string;
  #filename?: string;
  #timer?: NodeJS.Timeout;
  #serial: Promise<unknown> = Promise.resolve();
  #checking?: Promise<HistoryFreshness>;
  #closed = false;
  #closing?: Promise<void>;

  private constructor(source: HistorySource, options: HistoryWatchOptions) {
    this.#source = { ...source, path: path.resolve(source.path) };
    this.#options = options;
  }

  static async open(source: HistorySource, options: HistoryWatchOptions = {}): Promise<HistoryWatch> {
    const interval = options.pollIntervalMs ?? 30_000;
    if (!Number.isFinite(interval) || interval <= 0) throw new Error('History metadata check interval must be positive');
    const owner = new HistoryWatch(source, options);
    try {
      owner.#baseline = await owner.#pin();
      owner.#observed = owner.#baseline.sample;
      owner.#observe(owner.#baseline.sample);
      owner.#timer = setInterval(() => owner.#hint(), interval);
      owner.#timer.unref();
      return owner;
    } catch (error) {
      try { await owner.close(); }
      catch (cleanupError) { console.error(`Close history watcher after opening ${source.path} failed:`, cleanupError); }
      throw error;
    }
  }

  check(): Promise<HistoryFreshness> {
    if (this.#checking) return this.#checking;
    const operation = this.#run(() => this.#check());
    this.#checking = operation;
    void operation.then(() => {
      if (this.#checking === operation) this.#checking = undefined;
    }, () => {
      if (this.#checking === operation) this.#checking = undefined;
    });
    return operation;
  }

  capture(): Promise<HistoryCheckpoint> {
    return this.#run(async () => {
      const status = await this.#check();
      if (status.state === 'unverified') throw status.error;
      let pin: Pin | undefined;
      try {
        pin = await this.#pin();
        this.#record(pin.sample);
        this.#assertOpen();
        const checkpoint = {} as HistoryCheckpoint;
        this.#captures.set(checkpoint, { pin, revision: this.#revision });
        return checkpoint;
      } catch (error) {
        if (pin) {
          try { await this.#release(pin.handle); }
          catch (cleanupError) { console.error(`Release history capture for session ${this.#source.sessionId} failed:`, cleanupError); }
        }
        if (!this.#closed && error instanceof HistorySourceError) this.#unverified(error);
        throw error;
      }
    });
  }

  /** Consumes the checkpoint, including when a racing rewrite prevents acceptance. */
  accept(checkpoint: HistoryCheckpoint): Promise<boolean> {
    return this.#run(async () => {
      const capture = this.#captures.get(checkpoint);
      if (!capture) throw new HistoryStateError(`Accept history checkpoint for session ${this.#source.sessionId}: History checkpoint is not owned or has already been consumed`);
      try {
        const status = await this.#check();
        if (status.state === 'unverified' || capture.revision !== this.#revision ||
            !this.#observed || rewritten(capture.pin.sample, this.#observed)) return false;
        const previous = this.#baseline;
        this.#baseline = { handle: capture.pin.handle, sample: this.#observed };
        this.#dirty = false;
        this.#captures.delete(checkpoint);
        if (previous) await this.#release(previous.handle);
        this.#assertOpen();
        return true;
      } finally {
        if (this.#captures.delete(checkpoint)) await this.#release(capture.pin.handle);
      }
    });
  }

  discard(checkpoint: HistoryCheckpoint): Promise<void> {
    if (this.#closed) return this.close();
    return this.#run(async () => {
      const capture = this.#captures.get(checkpoint);
      if (!capture) return;
      this.#captures.delete(checkpoint);
      await this.#release(capture.pin.handle);
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#closing = this.#serial.then(async () => {
      this.#captures.clear();
      this.#baseline = undefined;
      const results = await Promise.allSettled([...this.#handles].map(handle => this.#release(handle)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, `Close history watcher for session ${this.#source.sessionId}: ${failures.map(diagnostic).join('\n')}`);
    });
    return this.#closing;
  }

  #assertOpen(): void {
    if (this.#closed) throw new HistoryClosedError(`History watcher is closed for session ${this.#source.sessionId}, source ${this.#source.path}`);
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new HistoryClosedError(`History watcher is closed for session ${this.#source.sessionId}, source ${this.#source.path}`));
    const operation = this.#serial.then(() => {
      this.#assertOpen();
      return work();
    });
    // The returned operation owns rejection; this tail only serializes subsequent work.
    this.#serial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #sample(): Promise<Sample> {
    const canonical = await historyOperation(`Resolve history source ${this.#source.path} for session ${this.#source.sessionId}`, () => realpath(this.#source.path));
    const metadata = await historyOperation(`Stat history source ${canonical} for session ${this.#source.sessionId}`, () => stat(canonical, { bigint: true }));
    const logical = await historyOperation(`Stat logical history source ${this.#source.path} for session ${this.#source.sessionId}`, () => stat(this.#source.path, { bigint: true }));
    this.#assertOpen();
    if (!metadata.isFile()) throw new HistorySourceError(`History source is not a regular file: ${this.#source.path}`);
    if (metadata.dev !== logical.dev || metadata.ino !== logical.ino) {
      throw new HistorySourceError(`History source changed while checking: ${this.#source.path}`);
    }
    return { canonical, metadata: logical };
  }

  async #pin(): Promise<Pin> {
    const canonical = await historyOperation(`Resolve history source ${this.#source.path} for session ${this.#source.sessionId}`, () => realpath(this.#source.path));
    const handle = await historyOperation(`Open history source ${canonical} for session ${this.#source.sessionId}`, () => open(canonical, 'r'));
    this.#handles.add(handle);
    try {
      this.#assertOpen();
      const metadata = await historyOperation(`Stat pinned history source ${canonical} for session ${this.#source.sessionId}`, () => handle.stat({ bigint: true }));
      if (!metadata.isFile()) throw new HistorySourceError(`History source is not a regular file: ${this.#source.path}`);
      const header = await readHistoryHeader(handle, `${this.#source.path} for session ${this.#source.sessionId}`);
      if (header.id !== this.#source.sessionId) {
        throw new HistorySourceError(`History source session identity changed at ${this.#source.path}: expected ${this.#source.sessionId}, found ${header.id}`);
      }
      const sample = await this.#sample();
      if (rewritten({ canonical, metadata }, sample)) {
        throw new HistorySourceError(`History source changed while capturing: ${this.#source.path}`);
      }
      return { handle, sample };
    } catch (error) {
      try { await this.#release(handle); }
      catch (cleanupError) { console.error(`Release history source ${canonical} for session ${this.#source.sessionId} failed:`, cleanupError); }
      throw error;
    }
  }

  async #release(handle: FileHandle): Promise<void> {
    if (this.#handles.delete(handle)) await historyOperation(`Close history source ${this.#source.path} for session ${this.#source.sessionId}`, () => handle.close());
  }

  async #check(): Promise<HistoryFreshness> {
    let verified: Pin | undefined;
    try {
      let sample = await this.#sample();
      if (!this.#observed || rewritten(this.#observed, sample)) {
        verified = await this.#pin();
        sample = verified.sample;
      }
      this.#observe(sample);
      this.#record(sample);
      this.#assertOpen();
      return this.#dirty ? { state: 'dirty' } : { state: 'clean' };
    } catch (error) {
      this.#assertOpen();
      if (!(error instanceof HistorySourceError)) throw error;
      return { state: 'unverified', error: this.#unverified(error) };
    } finally {
      if (verified) await this.#release(verified.handle);
    }
  }

  #record(sample: Sample): void {
    const changed = this.#observed && rewritten(this.#observed, sample);
    const recovered = this.#error !== undefined;
    if (changed) this.#revision++;
    this.#error = undefined;
    this.#observed = sample;
    if (changed || (this.#baseline && rewritten(this.#baseline.sample, sample))) this.#dirty = true;
    if ((changed || recovered) && this.#dirty) this.#options.onChange?.({ state: 'dirty' });
  }

  #unverified(error: unknown): unknown {
    this.#dirty = true;
    const key = diagnostic(error);
    if (this.#error?.diagnostic === key) return this.#error.error;
    this.#revision++;
    this.#error = { error, diagnostic: key };
    console.error(`History source is unverified for session ${this.#source.sessionId}, source ${this.#source.path}:`, error);
    this.#options.onChange?.({ state: 'unverified', error });
    return error;
  }

  #observe(sample: Sample): void {
    const directory = path.dirname(sample.canonical);
    this.#filename = path.basename(sample.canonical);
    if (this.#watcher && this.#directory === directory) return;
    this.#watcher?.close();
    this.#watcher = undefined;
    let watcher: FSWatcher;
    try {
      watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (this.#watcher === watcher && (filename === null || filename.toString() === this.#filename)) this.#hint();
      });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
      throw new HistorySourceError(`Watch history directory ${directory} for session ${this.#source.sessionId}: ${error.message}`, {cause: error});
    }
    watcher.on('error', error => {
      const failure = new HistorySourceError(`Watch history directory ${directory} for session ${this.#source.sessionId}: ${error.message}`, {cause: error});
      if (this.#closed || this.#watcher !== watcher) { console.error(failure); return; }
      watcher.close();
      this.#watcher = undefined;
      void this.#run(async () => { this.#unverified(failure); }).catch(error => {
        if (!(error instanceof HistoryClosedError)) console.error(`Record history watch failure for session ${this.#source.sessionId}:`, error);
      });
    });
    this.#directory = directory;
    this.#watcher = watcher;
  }

  #hint(): void {
    if (!this.#closed) void this.check().catch(error => {
      if (!(error instanceof HistoryClosedError)) console.error(`Check history source ${this.#source.path} for session ${this.#source.sessionId}:`, error);
    });
  }
}
