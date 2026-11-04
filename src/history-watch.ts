import { watch, type BigIntStats, type FSWatcher } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

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

export async function readHistoryHeader(handle: FileHandle): Promise<{ id: string; cwd: string }> {
  const buffer = Buffer.alloc(64 * 1024);
  const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
  const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
  let header = JSON.parse(lines[0] || '{}') as Record<string, unknown>;
  if (header.type === 'title' && header.v === 1) header = JSON.parse(lines[1] || '{}') as Record<string, unknown>;
  if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string') {
    throw new Error('Unsupported managed OMP session history format');
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
      await owner.close();
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
        if (pin) await this.#release(pin.handle);
        if (!this.#closed) this.#unverified(error);
        throw error;
      }
    });
  }

  /** Consumes the checkpoint, including when a racing rewrite prevents acceptance. */
  accept(checkpoint: HistoryCheckpoint): Promise<boolean> {
    return this.#run(async () => {
      const capture = this.#captures.get(checkpoint);
      if (!capture) throw new Error('History checkpoint is not owned or has already been consumed');
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
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.#closing;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('History watcher is closed');
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('History watcher is closed'));
    const operation = this.#serial.then(() => {
      this.#assertOpen();
      return work();
    });
    this.#serial = operation.catch(() => {});
    return operation;
  }

  async #sample(): Promise<Sample> {
    const canonical = await realpath(this.#source.path);
    const metadata = await stat(canonical, { bigint: true });
    const logical = await stat(this.#source.path, { bigint: true });
    this.#assertOpen();
    if (!metadata.isFile()) throw new Error(`History source is not a regular file: ${this.#source.path}`);
    if (metadata.dev !== logical.dev || metadata.ino !== logical.ino) {
      throw new Error(`History source changed while checking: ${this.#source.path}`);
    }
    return { canonical, metadata: logical };
  }

  async #pin(): Promise<Pin> {
    const canonical = await realpath(this.#source.path);
    const handle = await open(canonical, 'r');
    this.#handles.add(handle);
    try {
      this.#assertOpen();
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile()) throw new Error(`History source is not a regular file: ${this.#source.path}`);
      const header = await readHistoryHeader(handle);
      if (header.id !== this.#source.sessionId) {
        throw new Error(`History source session identity changed: expected ${this.#source.sessionId}, found ${header.id}`);
      }
      const sample = await this.#sample();
      if (rewritten({ canonical, metadata }, sample)) {
        throw new Error(`History source changed while capturing: ${this.#source.path}`);
      }
      return { handle, sample };
    } catch (error) {
      await this.#release(handle);
      throw error;
    }
  }

  async #release(handle: FileHandle): Promise<void> {
    if (this.#handles.delete(handle)) await handle.close();
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
    this.#options.onChange?.({ state: 'unverified', error });
    return error;
  }

  #observe(sample: Sample): void {
    const directory = path.dirname(sample.canonical);
    this.#filename = path.basename(sample.canonical);
    if (this.#watcher && this.#directory === directory) return;
    this.#watcher?.close();
    this.#watcher = undefined;
    const watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (this.#watcher === watcher && (filename === null || filename.toString() === this.#filename)) this.#hint();
    });
    watcher.on('error', error => {
      if (this.#closed || this.#watcher !== watcher) return;
      watcher.close();
      this.#watcher = undefined;
      void this.#run(async () => { this.#unverified(error); }).catch(() => {});
    });
    this.#directory = directory;
    this.#watcher = watcher;
  }

  #hint(): void {
    if (!this.#closed) void this.check().catch(() => {});
  }
}
