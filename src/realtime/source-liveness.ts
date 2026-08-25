import type { RealtimeSource } from "./scheduler.js";

const REQUIRED_SOURCES: readonly RealtimeSource[] = ["trenches", "rank_1m", "rank_5m"];

export interface SourceLivenessWatchdogOptions {
  readonly startedAt: number;
  readonly timeoutMs?: number;
  readonly sources?: readonly RealtimeSource[];
}

export class SourceLivenessWatchdog {
  private readonly timeoutMs: number;
  private readonly sources: readonly RealtimeSource[];
  private readonly lastSuccess = new Map<RealtimeSource, number>();

  public constructor(private readonly options: SourceLivenessWatchdogOptions) {
    if (!Number.isSafeInteger(options.startedAt) || options.startedAt < 0) {
      throw new RangeError("Watchdog start time must be a non-negative integer");
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("Watchdog timeout must be a positive integer");
    }
    this.sources = options.sources ?? REQUIRED_SOURCES;
    if (this.sources.length === 0 || new Set(this.sources).size !== this.sources.length) {
      throw new Error("Watchdog requires a non-empty unique source list");
    }
  }

  public markSuccess(source: RealtimeSource, succeededAt: number): void {
    if (!this.sources.includes(source)) return;
    if (!Number.isSafeInteger(succeededAt) || succeededAt < this.options.startedAt) {
      throw new RangeError("Source success time must not precede watchdog startup");
    }
    const previous = this.lastSuccess.get(source) ?? this.options.startedAt;
    this.lastSuccess.set(source, Math.max(previous, succeededAt));
  }

  public staleSources(now: number): readonly RealtimeSource[] {
    if (!Number.isSafeInteger(now) || now < this.options.startedAt) {
      throw new RangeError("Watchdog check time must not precede startup");
    }
    return this.sources.filter(
      (source) => now - (this.lastSuccess.get(source) ?? this.options.startedAt) >= this.timeoutMs,
    );
  }
}
