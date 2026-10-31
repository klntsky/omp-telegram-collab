const idle = Promise.resolve();

export class TopicWriter {
  private desired: string | undefined;
  private pending = false;
  private worker: Promise<void> | undefined;

  constructor(
    private readonly deliver: (take: () => string | undefined) => Promise<string | undefined>,
    private readonly active: () => boolean,
    private readonly onError: (error: unknown) => void,
  ) {}

  publish(value: string | undefined): Promise<void> {
    if (value !== this.desired) {
      this.desired = value;
      this.pending = value !== undefined;
    }
    return this.start();
  }

  observe(value: string): Promise<void> {
    if (this.desired !== undefined && value !== this.desired) this.pending = true;
    return this.start();
  }

  get completion(): Promise<void> {
    return this.worker ?? idle;
  }

  private start(): Promise<void> {
    if (!this.worker && this.pending && this.desired !== undefined && this.active()) {
      this.worker = idle.then(() => this.drain());
    }
    return this.completion;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending && this.desired !== undefined && this.active()) {
        const sent = await this.deliver(() => {
          if (!this.pending || this.desired === undefined || !this.active()) return undefined;
          this.pending = false;
          return this.desired;
        });
        if (sent === undefined) return;
      }
    } catch (error) {
      this.pending = this.desired !== undefined;
      if (this.active()) this.onError(error);
    } finally {
      this.worker = undefined;
    }
  }
}
