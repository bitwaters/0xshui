import { createHash } from "node:crypto";

import type { AppConfig } from "../config/index.js";
import type { PersistenceRepository } from "../db/index.js";
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
    readonly shadow72h: boolean;
    readonly shadowHeartbeatFresh: boolean;
    readonly qualifiedToSentP95: boolean;
    readonly fastSourceToSentP95: boolean;
    readonly stableRateLimit24h: boolean;
    readonly hasOutcomeCoverage: boolean;
  };
  readonly eligibleForManualApproval: boolean;
  readonly productionActivation: "blocked" | "approved";
  readonly schemaFailureCount: number;
  readonly rateLimitCount: number;
  readonly lastSchemaFailureAt: number | null;
  readonly reasons: readonly string[];
}

export class AcceptanceService {
  private readonly metrics: MetricsService;

  public constructor(
    private readonly repository: PersistenceRepository,
    private readonly configKey?: string,
  ) {
    this.metrics = new MetricsService(repository);
  }

  public ensureShadowStarted(now: number): number {
    if (this.configKey === undefined) throw new Error("Acceptance config key is required");
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
    if (this.configKey === undefined) throw new Error("Acceptance config key is required");
    const startedAt =
      this.repository.getRuntimeState<number>(`shadow_started_at:${this.configKey}`) ?? now;
    const heartbeat = this.repository.getRuntimeState<number>(
      `shadow_last_heartbeat:${this.configKey}`,
    );
    const metrics = this.metrics.collect(startedAt, now + 1);
    const lastUncontrolled = this.repository.getRuntimeState<number>("last_uncontrolled_429_at");
    const gates = {
      shadow72h: now - startedAt >= 72 * HOUR_MS,
      shadowHeartbeatFresh:
        heartbeat !== null && heartbeat <= now && now - heartbeat <= MAX_HEARTBEAT_GAP_MS,
      qualifiedToSentP95:
        metrics.qualifiedToSent.samples > 0 && (metrics.qualifiedToSent.p95 ?? Infinity) < 5_000,
      fastSourceToSentP95:
        metrics.fastSourceToSent.samples > 0 && (metrics.fastSourceToSent.p95 ?? Infinity) < 10_000,
      stableRateLimit24h:
        lastUncontrolled === null || lastUncontrolled < now - 24 * HOUR_MS,
      hasOutcomeCoverage: metrics.outcomeCoverage15 !== null,
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
      eligibleForManualApproval: reasons.length === 0,
      productionActivation: approved ? "approved" : "blocked",
      schemaFailureCount: this.repository.getRuntimeState<number>("schema_failure_count") ?? 0,
      rateLimitCount: this.repository.getRuntimeState<number>("rate_limit_count") ?? 0,
      lastSchemaFailureAt: this.repository.getRuntimeState<number>("last_schema_failure_at"),
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
