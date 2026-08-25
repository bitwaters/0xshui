import { createHash } from "node:crypto";

import type { AppConfig } from "../config/index.js";
import type { PersistenceRepository } from "../db/index.js";
import { aggregateStatistics } from "../stats/index.js";
import { MetricsService, type OperationalMetrics } from "./metrics.js";

const HOUR_MS = 60 * 60_000;
const MAX_HEARTBEAT_GAP_MS = 5 * 60_000;

export function acceptanceConfigKey(config: Readonly<AppConfig>): string {
  const relevant = {
    poll_interval: config.poll_interval,
    gmgn: {
      request_timeout: config.gmgn.request_timeout,
      network_retry: config.gmgn.network_retry,
      local_weight_limit_per_second: config.gmgn.local_weight_limit_per_second,
      security_cache: config.gmgn.security_cache,
      security_max_age_at_send: config.gmgn.security_max_age_at_send,
      security_max_concurrency: config.gmgn.security_max_concurrency,
      source_max_age_for_trigger: config.gmgn.source_max_age_for_trigger,
    },
    trenches: config.trenches,
    rank: config.rank,
    risk_filters: config.risk_filters,
    curve_preheat: config.curve_preheat,
    curve_trigger: config.curve_trigger,
    fast_rank_trigger: config.fast_rank_trigger,
    cross_source_trigger: config.cross_source_trigger,
    confirmation: config.confirmation,
    cancel: config.cancel,
    noise: config.noise,
    outcomes: config.outcomes,
    baseline_snapshot_interval: config.storage.baseline_snapshot_interval,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

export interface AcceptanceReport {
  readonly generatedAt: number;
  readonly shadowStartedAt: number;
  readonly shadowHours: number;
  readonly metrics: OperationalMetrics;
  readonly gates: {
    readonly validSamples100: boolean;
    readonly eachTrigger20: boolean;
    readonly outcomeCoverage90: boolean;
    readonly latencySamples30: boolean;
    readonly qualifiedToSentP95: boolean;
    readonly fastSourceToSentP95: boolean;
    readonly gmgnRequests10000: boolean;
    readonly gmgnSuccess99: boolean;
    readonly noUncontrolled429: boolean;
    readonly noCriticalSchemaFailures: boolean;
  };
  readonly validSamples: number;
  readonly triggerSamples: Readonly<Record<string, number>>;
  readonly nextReviewAt: number;
  readonly gmgnRequests: {
    readonly attempts: number;
    readonly successes: number;
    readonly successRate: number | null;
  };
  readonly eligibleForManualApproval: boolean;
  readonly productionActivation: "blocked" | "approved";
  readonly schemaFailureCount: number;
  readonly rateLimitCount: number;
  readonly uncontrolledRateLimitCount: number;
  readonly lastSchemaFailureAt: number | null;
  readonly reasons: readonly string[];
}

export class AcceptanceService {
  private readonly metrics: MetricsService;

  public constructor(
    private readonly repository: PersistenceRepository,
    private readonly configKey?: string,
    private readonly configVersion?: number,
  ) {
    this.metrics = new MetricsService(repository);
  }

  public ensureShadowStarted(now: number): number {
    if (this.configKey === undefined || this.configVersion === undefined) {
      throw new Error("Acceptance config key and version are required");
    }
    const startKey = `shadow_started_at:${this.configKey}`;
    const heartbeatKey = `shadow_last_heartbeat:${this.configKey}`;
    const existing = this.repository.getRuntimeState<number>(startKey);
    const heartbeat = this.repository.getRuntimeState<number>(heartbeatKey);
    const startedAt =
      existing === null ||
      heartbeat === null ||
      now < heartbeat ||
      now - heartbeat > MAX_HEARTBEAT_GAP_MS
        ? now
        : existing;
    this.repository.setRuntimeState(startKey, startedAt, now);
    this.repository.setRuntimeState(heartbeatKey, now, now);
    return startedAt;
  }

  public recordHeartbeat(now: number): number {
    return this.ensureShadowStarted(now);
  }

  public report(now: number): AcceptanceReport {
    if (this.configKey === undefined || this.configVersion === undefined) {
      throw new Error("Acceptance config key and version are required");
    }
    const startedAt =
      this.repository.getRuntimeState<number>(`shadow_started_at:${this.configKey}`) ?? now;
    const metrics = this.metrics.collect(0, now + 1, this.configVersion);
    const stats = aggregateStatistics(
      this.repository.listStatisticsSignals(0, now + 1, this.configVersion),
      now,
    );
    const triggerSamples = Object.fromEntries(
      stats.sources
        .filter((source) =>
          ["curve_acceleration", "fast_rank", "cross_source"].includes(source.source),
        )
        .map((source) => [source.source, source.eligible1h]),
    );
    const attempts =
      this.repository.getRuntimeState<number>(`gmgn_request_attempts:${this.configKey}`) ?? 0;
    const successes =
      this.repository.getRuntimeState<number>(`gmgn_request_successes:${this.configKey}`) ?? 0;
    const schemaFailureCount =
      this.repository.getRuntimeState<number>(`schema_failure_count:${this.configKey}`) ?? 0;
    const uncontrolledRateLimitCount =
      this.repository.getRuntimeState<number>(`uncontrolled_429_count:${this.configKey}`) ?? 0;
    const rateLimitCount =
      this.repository.getRuntimeState<number>(`rate_limit_count:${this.configKey}`) ?? 0;
    const successRate = attempts === 0 ? null : successes / attempts;
    const gates = {
      validSamples100: stats.validSamples1h >= 100,
      eachTrigger20: ["curve_acceleration", "fast_rank", "cross_source"].every(
        (trigger) => (triggerSamples[trigger] ?? 0) >= 20,
      ),
      outcomeCoverage90: (stats.coverage1h ?? 0) >= 0.9,
      latencySamples30: metrics.qualifiedToSent.samples >= 30,
      qualifiedToSentP95:
        metrics.qualifiedToSent.samples >= 30 &&
        (metrics.qualifiedToSent.p95 ?? Infinity) < 5_000,
      fastSourceToSentP95:
        (triggerSamples.fast_rank ?? 0) >= 20 &&
        metrics.fastSourceToSent.samples >= 20 &&
        (metrics.fastSourceToSent.p95 ?? Infinity) < 10_000,
      gmgnRequests10000: attempts >= 10_000,
      gmgnSuccess99: attempts >= 10_000 && (successRate ?? 0) >= 0.99,
      noUncontrolled429: uncontrolledRateLimitCount === 0,
      noCriticalSchemaFailures: schemaFailureCount === 0,
    };
    const reasons = Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    const approvedKey = this.repository.getRuntimeState<string>(
      "production_approved_config_key",
    );
    const approved =
      reasons.length === 0 &&
      this.configKey !== undefined &&
      approvedKey === this.configKey;
    return {
      generatedAt: now,
      shadowStartedAt: startedAt,
      shadowHours: (now - startedAt) / HOUR_MS,
      metrics,
      gates,
      validSamples: stats.validSamples1h,
      triggerSamples,
      nextReviewAt: stats.nextReviewAt,
      gmgnRequests: { attempts, successes, successRate },
      eligibleForManualApproval: reasons.length === 0,
      productionActivation: approved ? "approved" : "blocked",
      schemaFailureCount,
      rateLimitCount,
      uncontrolledRateLimitCount,
      lastSchemaFailureAt: this.repository.getRuntimeState<number>(
        `last_schema_failure_at:${this.configKey}`,
      ),
      reasons,
    };
  }

  public approve(now: number): AcceptanceReport {
    if (this.configKey === undefined) throw new Error("Acceptance config key is required for approval");
    const report = this.report(now);
    if (!report.eligibleForManualApproval) throw new Error("Acceptance gates have not passed");
    this.repository.setRuntimeState("production_approved_config_key", this.configKey, now);
    this.repository.setRuntimeState("production_approved_at", now, now);
    return this.report(now);
  }

  public reject(now: number): AcceptanceReport {
    this.repository.setRuntimeState("production_approved_config_key", null, now);
    this.repository.setRuntimeState("production_rejected_at", now, now);
    return this.report(now);
  }
}
