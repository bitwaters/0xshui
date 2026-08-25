export type RealtimeSource = "trenches" | "rank_1m" | "rank_5m";

export interface PollResult<T> {
  readonly value: T;
  readonly sourceCapturedAt: number;
}

export interface SourcePoller<T = unknown> {
  readonly poll: () => Promise<PollResult<T>>;
  readonly onSuccess: (source: RealtimeSource, result: PollResult<T>) => Promise<void> | void;
  readonly onFailure?: (source: RealtimeSource, error: unknown) => Promise<void> | void;
  readonly onOverlap?: (source: RealtimeSource) => void;
}

export interface SchedulerOptions {
  readonly intervalMs: number;
  readonly sources: Readonly<Record<RealtimeSource, SourcePoller>>;
}

const SOURCE_ORDER: readonly RealtimeSource[] = ["trenches", "rank_1m", "rank_5m"];

export class RealtimeScheduler {
  private readonly inFlight = new Map<RealtimeSource, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  public constructor(private readonly options: SchedulerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new RangeError("Scheduler interval must be a positive integer");
    }
  }

  public start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => {
      if (!this.stopped) {
        void this.tick();
      }
    }, this.options.intervalMs);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.waitForIdle();
  }

  public async tick(): Promise<void> {
    for (const source of SOURCE_ORDER) {
      if (this.inFlight.has(source)) {
        this.options.sources[source].onOverlap?.(source);
        continue;
      }
      const task = this.runSource(source);
      this.inFlight.set(source, task);
      void task
        .finally(() => this.inFlight.delete(source))
        .catch(() => undefined);
    }
    await Promise.resolve();
  }

  public async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  public isInFlight(source: RealtimeSource): boolean {
    return this.inFlight.has(source);
  }

  private async runSource(source: RealtimeSource): Promise<void> {
    const poller = this.options.sources[source];
    try {
      const result = await poller.poll();
      await poller.onSuccess(source, result);
    } catch (error) {
      await poller.onFailure?.(source, error);
    }
  }
}
