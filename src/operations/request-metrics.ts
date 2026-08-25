import type { GmgnRequestMetric } from "../gmgn/index.js";
import type { LatencyMetric } from "./metrics.js";

export interface GmgnRequestMetricsSnapshot {
  readonly attempts: number;
  readonly successes: number;
  readonly successRate: number | null;
  readonly latency: LatencyMetric;
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

export class GmgnRequestMetrics {
  private attempts = 0;
  private successes = 0;
  private readonly durations: number[] = [];

  public constructor(private readonly maximumSamples = 10_000) {
    if (!Number.isSafeInteger(maximumSamples) || maximumSamples <= 0) {
      throw new RangeError("Maximum GMGN metric samples must be a positive integer");
    }
  }

  public record(metric: GmgnRequestMetric): void {
    if (!Number.isFinite(metric.durationMs) || metric.durationMs < 0) return;
    this.attempts += 1;
    if (metric.success) this.successes += 1;
    this.durations.push(metric.durationMs);
    if (this.durations.length > this.maximumSamples) this.durations.shift();
  }

  public snapshot(reset = false): GmgnRequestMetricsSnapshot {
    const snapshot = {
      attempts: this.attempts,
      successes: this.successes,
      successRate: this.attempts === 0 ? null : this.successes / this.attempts,
      latency: {
        samples: this.durations.length,
        p50: percentile(this.durations, 0.5),
        p95: percentile(this.durations, 0.95),
      },
    };
    if (reset) {
      this.attempts = 0;
      this.successes = 0;
      this.durations.length = 0;
    }
    return snapshot;
  }
}
