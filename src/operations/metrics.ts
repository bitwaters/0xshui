import type { PersistenceRepository } from "../db/index.js";
import { aggregateStatistics } from "../stats/index.js";

export interface LatencyMetric {
  readonly samples: number;
  readonly p50: number | null;
  readonly p95: number | null;
}

export interface OperationalMetrics {
  readonly from: number;
  readonly to: number;
  readonly signals: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly qualifiedToSent: LatencyMetric;
  readonly fastSourceToSent: LatencyMetric;
  readonly securityToSent: LatencyMetric;
  readonly telegramAttemptToSent: LatencyMetric;
  readonly pendingOutcomeJobs: number;
  readonly cooldownUntil: number | null;
  readonly outcomeCoverage15: number | null;
  readonly outcomeCoverage1h: number | null;
  readonly hitRate15: number | null;
  readonly largeGainRate1h: number | null;
  readonly medianMfe15: number | null;
  readonly medianMae15: number | null;
}

function triggerOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.trigger === "string") return record.trigger;
  const evidence = record.evidence;
  return typeof evidence === "object" && evidence !== null && !Array.isArray(evidence) &&
    typeof (evidence as Record<string, unknown>).trigger === "string"
    ? ((evidence as Record<string, unknown>).trigger as string)
    : null;
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function latency(values: readonly number[]): LatencyMetric {
  return { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

export class MetricsService {
  public constructor(private readonly repository: PersistenceRepository) {}

  public collect(from: number, to: number, configVersion?: number): OperationalMetrics {
    const rows = this.repository.listOperationalSignals(from, to, configVersion);
    const qualified: number[] = [];
    const fastSource: number[] = [];
    const security: number[] = [];
    const telegram: number[] = [];
    const rejectionCounts: Record<string, number> = {};
    const stateCounts: Record<string, number> = {};
    for (const row of rows) {
      stateCounts[row.state] = (stateCounts[row.state] ?? 0) + 1;
      if (row.reason !== null && ["rejected", "cancelled", "suppressed"].includes(row.state)) {
        rejectionCounts[row.reason] = (rejectionCounts[row.reason] ?? 0) + 1;
      }
      if (row.sentAt === null) continue;
      if (row.qualifiedAt !== null && row.sentAt >= row.qualifiedAt) {
        qualified.push(row.sentAt - row.qualifiedAt);
      }
      if (
        triggerOf(row.decision) === "fast_rank" &&
        row.sourceCapturedAt !== null &&
        row.sentAt >= row.sourceCapturedAt
      ) {
        fastSource.push(row.sentAt - row.sourceCapturedAt);
      }
      if (row.securityCompletedAt !== null && row.sentAt >= row.securityCompletedAt) {
        security.push(row.sentAt - row.securityCompletedAt);
      }
      if (row.telegramAttemptedAt !== null && row.sentAt >= row.telegramAttemptedAt) {
        telegram.push(row.sentAt - row.telegramAttemptedAt);
      }
    }
    const stats = aggregateStatistics(
      this.repository.listStatisticsSignals(from, to, configVersion),
      to,
    );
    return {
      from,
      to,
      signals: stats.signals,
      rejectionCounts,
      stateCounts,
      qualifiedToSent: latency(qualified),
      fastSourceToSent: latency(fastSource),
      securityToSent: latency(security),
      telegramAttemptToSent: latency(telegram),
      pendingOutcomeJobs: this.repository.countPendingOutcomes(configVersion),
      cooldownUntil: this.repository.getRuntimeState<number>("gmgn_cooldown_until"),
      outcomeCoverage15: stats.coverage15,
      outcomeCoverage1h: stats.coverage1h,
      hitRate15: stats.hitRate15,
      largeGainRate1h: stats.largeGainRate1h,
      medianMfe15: stats.medianMfe15,
      medianMae15: stats.medianMae15,
    };
  }
}
