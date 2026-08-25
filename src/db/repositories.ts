import { createHash } from "node:crypto";

import type { SqliteDatabase } from "./database.js";
import type {
  CandidateDecision,
  OutcomeRecord,
  OperationalSignalRow,
  PendingOutcomeJob,
  ReplayEvent,
  RecoveredState,
  SecurityEvent,
  SignalState,
  SnapshotEvent,
  SignalStateSummary,
  SnapshotSource,
  StatisticsSignalRow,
  StoredConfigVersion,
  StoredDetectionState,
} from "./types.js";

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable");
  }
  return serialized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export class PersistenceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public appendSourceBatch(source: SnapshotSource, events: readonly SnapshotEvent[]): number | null {
    if (events.length === 0) {
      return null;
    }
    return this.database.transaction(() => {
      const ingestSeq = this.allocateIngestSeq();
      const insert = this.database.prepare(`
        INSERT INTO token_snapshots (
          ingest_seq, source, event_type, token_key, captured_at, source_captured_at,
          sampling_level, payload_json, upstream_filter_version, adapter_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of [...events].sort((left, right) => left.tokenKey.localeCompare(right.tokenKey))) {
        insert.run(
          ingestSeq,
          source,
          event.eventType,
          event.tokenKey,
          event.capturedAt,
          event.sourceCapturedAt,
          event.samplingLevel,
          serializeJson(event.payload),
          event.upstreamFilterVersion,
          event.adapterVersion,
        );
      }
      return ingestSeq;
    })();
  }

  public appendSecurityEvent(event: SecurityEvent): number {
    return this.database.transaction(() => {
      const ingestSeq = this.allocateIngestSeq();
      this.database
        .prepare(`
          INSERT INTO security_checks (
            ingest_seq, token_key, captured_at, status, reason, payload_json, adapter_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          ingestSeq,
          event.tokenKey,
          event.capturedAt,
          event.status,
          event.reason ?? null,
          serializeJson(event.payload),
          event.adapterVersion,
        );
      return ingestSeq;
    })();
  }

  public registerConfigVersion(config: unknown, now = Date.now()): number {
    const configJson = serializeJson(canonicalize(config));
    const contentHash = createHash("sha256").update(configJson).digest("hex");
    this.database
      .prepare(`
        INSERT INTO config_versions (content_hash, config_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(content_hash) DO NOTHING
      `)
      .run(contentHash, configJson, now);
    const row = this.database
      .prepare("SELECT version FROM config_versions WHERE content_hash = ?")
      .get(contentHash) as { version: number } | undefined;
    if (row === undefined) {
      throw new Error("Unable to resolve persisted configuration version");
    }
    return row.version;
  }

  public getConfigVersion(version?: number): StoredConfigVersion | null {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
      throw new RangeError("Config version must be a positive integer");
    }
    const row = this.database
      .prepare(`
        SELECT version, config_json AS configJson, created_at AS createdAt
        FROM config_versions
        ${version === undefined ? "ORDER BY version DESC LIMIT 1" : "WHERE version = ?"}
      `)
      .get(...(version === undefined ? [] : [version])) as
      | { version: number; configJson: string; createdAt: number }
      | undefined;
    return row === undefined
      ? null
      : { version: row.version, config: JSON.parse(row.configJson) as unknown, createdAt: row.createdAt };
  }

  public listReplayEvents(from: number, to: number): readonly ReplayEvent[] {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new RangeError("Replay range must be an increasing pair of non-negative integers");
    }
    const rows = this.database
      .prepare(`
        SELECT 'snapshot' AS kind, ingest_seq AS ingestSeq, source, token_key AS tokenKey,
               event_type AS eventType, captured_at AS capturedAt,
               source_captured_at AS sourceCapturedAt, sampling_level AS samplingLevel,
               payload_json AS payloadJson, upstream_filter_version AS upstreamFilterVersion,
               adapter_version AS adapterVersion, NULL AS status, NULL AS reason
        FROM token_snapshots
        WHERE captured_at >= ? AND captured_at < ?
        UNION ALL
        SELECT 'security' AS kind, ingest_seq AS ingestSeq, NULL AS source,
               token_key AS tokenKey, 'security' AS eventType, captured_at AS capturedAt,
               captured_at AS sourceCapturedAt, NULL AS samplingLevel,
               payload_json AS payloadJson, NULL AS upstreamFilterVersion,
               adapter_version AS adapterVersion, status, reason
        FROM security_checks
        WHERE captured_at >= ? AND captured_at < ?
        ORDER BY ingestSeq, kind, tokenKey
      `)
      .all(from, to, from, to) as Array<Record<string, unknown>>;
    return rows.map((row): ReplayEvent => {
      const common = {
        ingestSeq: row.ingestSeq as number,
        tokenKey: row.tokenKey as string,
        capturedAt: row.capturedAt as number,
        payload: JSON.parse(row.payloadJson as string) as unknown,
        adapterVersion: row.adapterVersion as string,
      };
      if (row.kind === "security") {
        return {
          kind: "security",
          ...common,
          status: row.status as SecurityEvent["status"],
          reason: row.reason as string | null,
        };
      }
      return {
        kind: "snapshot",
        ...common,
        source: row.source as SnapshotSource,
        eventType: row.eventType as SnapshotEvent["eventType"],
        sourceCapturedAt: row.sourceCapturedAt as number,
        samplingLevel: row.samplingLevel as SnapshotEvent["samplingLevel"],
        upstreamFilterVersion: row.upstreamFilterVersion as string,
      };
    });
  }

  public upsertCandidateDecision(decision: CandidateDecision): boolean {
    const result = this.database
      .prepare(`
        INSERT INTO signals (
          token_key, creator_address, lifecycle, state, reason, priority, config_version,
          decision_json, first_discovered_at, qualified_at, security_completed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_key) DO UPDATE SET
          creator_address = COALESCE(excluded.creator_address, signals.creator_address),
          lifecycle = excluded.lifecycle,
          state = excluded.state,
          reason = excluded.reason,
          priority = excluded.priority,
          config_version = excluded.config_version,
          decision_json = excluded.decision_json,
          qualified_at = COALESCE(excluded.qualified_at, signals.qualified_at),
          security_completed_at = COALESCE(
            excluded.security_completed_at,
            signals.security_completed_at
          ),
          updated_at = excluded.updated_at
        WHERE signals.state IN (
          'observing', 'security_pending', 'qualified', 'rejected', 'cancelled', 'suppressed'
        )
      `)
      .run(
        decision.tokenKey,
        decision.creatorAddress ?? null,
        decision.lifecycle,
        decision.state,
        decision.reason ?? null,
        decision.priority,
        decision.configVersion,
        serializeJson(decision.decision),
        decision.firstDiscoveredAt,
        decision.qualifiedAt ?? null,
        decision.securityCompletedAt ?? null,
        decision.now,
        decision.now,
      );
    return result.changes === 1;
  }

  public tryMarkDeliveryPending(tokenKey: string, now: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals
        SET state = 'delivery_pending', delivery_attempts = delivery_attempts + 1,
            telegram_attempted_at = ?, updated_at = ?
        WHERE token_key = ? AND state = 'qualified'
      `)
      .run(now, now, tokenKey);
    return result.changes === 1;
  }

  public cancelQualifiedDelivery(tokenKey: string, reason: string, now: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals SET state = 'cancelled', reason = ?, updated_at = ?
        WHERE token_key = ? AND state = 'qualified'
      `)
      .run(reason, now, tokenKey);
    return result.changes === 1;
  }

  public releaseDeliveryForRetry(tokenKey: string, reason: string, now: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals SET state = 'qualified', reason = ?, updated_at = ?
        WHERE token_key = ? AND state = 'delivery_pending' AND delivery_attempts < 3
      `)
      .run(reason, now, tokenKey);
    return result.changes === 1;
  }

  public markDeliveryNotSent(tokenKey: string, reason: string, now: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals SET state = 'cancelled', reason = ?, updated_at = ?
        WHERE token_key = ? AND state = 'delivery_pending'
      `)
      .run(reason, now, tokenKey);
    return result.changes === 1;
  }

  public getDeliveryTarget(tokenKey: string): {
    readonly state: SignalState;
    readonly telegramMessageId: number | null;
    readonly attempts: number;
  } | null {
    const row = this.database
      .prepare(`
        SELECT state, telegram_message_id AS telegramMessageId, delivery_attempts AS attempts
        FROM signals WHERE token_key = ?
      `)
      .get(tokenKey) as
      | { state: SignalState; telegramMessageId: number | null; attempts: number }
      | undefined;
    return row ?? null;
  }

  public getDetectionState(tokenKey: string): StoredDetectionState | null {
    const row = this.database
      .prepare(`
        SELECT state, lifecycle, priority, decision_json AS decisionJson,
               first_discovered_at AS firstDiscoveredAt,
               qualified_at AS qualifiedAt,
               security_completed_at AS securityCompletedAt
        FROM signals WHERE token_key = ?
      `)
      .get(tokenKey) as
      | (Omit<StoredDetectionState, "decision"> & { decisionJson: string })
      | undefined;
    if (row === undefined) return null;
    const { decisionJson, ...state } = row;
    return { ...state, decision: JSON.parse(decisionJson) as unknown };
  }

  public markDeliveryUnknown(tokenKey: string, reason: string, now: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals SET state = 'delivery_unknown', reason = ?, updated_at = ?
        WHERE token_key = ? AND state = 'delivery_pending'
      `)
      .run(reason, now, tokenKey);
    return result.changes === 1;
  }

  public markSent(
    tokenKey: string,
    telegramMessageId: number,
    sentAt: number,
    sentPrice?: number,
    sentMarketCap?: number,
    outcomeCheckpointsMs: readonly number[] = [15 * 60_000, 60 * 60_000],
  ): boolean {
    if (
      outcomeCheckpointsMs.length !== 2 ||
      new Set(outcomeCheckpointsMs).size !== 2 ||
      outcomeCheckpointsMs.some((value) => !Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new RangeError("Exactly two unique positive outcome checkpoints are required");
    }
    return this.database.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE signals
          SET state = 'sent', telegram_message_id = ?, sent_at = ?, sent_price = ?,
              sent_market_cap = ?, updated_at = ?
          WHERE token_key = ? AND state = 'delivery_pending'
        `)
        .run(
          telegramMessageId,
          sentAt,
          sentPrice ?? null,
          sentMarketCap ?? null,
          sentAt,
          tokenKey,
        );
      if (result.changes !== 1) {
        return false;
      }
      const signal = this.database
        .prepare("SELECT id FROM signals WHERE token_key = ?")
        .get(tokenKey) as { id: number };
      const insert = this.database.prepare(`
        INSERT INTO signal_outcomes (
          signal_id, checkpoint_ms, due_at, state, attempt_count, next_attempt_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
      `);
      for (const checkpointMs of [...outcomeCheckpointsMs].sort((a, b) => a - b)) {
        const dueAt = sentAt + checkpointMs;
        insert.run(signal.id, checkpointMs, dueAt, dueAt, sentAt, sentAt);
      }
      return true;
    })();
  }

  public markConfirmed(tokenKey: string, confirmedAt: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals SET state = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE token_key = ? AND state = 'sent' AND telegram_message_id IS NOT NULL
      `)
      .run(confirmedAt, confirmedAt, tokenKey);
    return result.changes === 1;
  }

  public saveOutcome(outcome: OutcomeRecord): void {
    this.database
      .prepare(`
        INSERT INTO signal_outcomes (
          signal_id, checkpoint_ms, due_at, state, attempt_count, next_attempt_at,
          result_json, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signal_id, checkpoint_ms) DO UPDATE SET
          state = excluded.state,
          attempt_count = excluded.attempt_count,
          next_attempt_at = excluded.next_attempt_at,
          result_json = excluded.result_json,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
        WHERE signal_outcomes.state = 'pending'
      `)
      .run(
        outcome.signalId,
        outcome.checkpointMs,
        outcome.dueAt,
        outcome.state,
        outcome.attemptCount,
        outcome.nextAttemptAt ?? null,
        outcome.result === undefined ? null : serializeJson(outcome.result),
        outcome.completedAt ?? null,
        outcome.now,
        outcome.now,
      );
  }

  public listDueOutcomeJobs(now: number, limit = 20): readonly PendingOutcomeJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Outcome job limit must be between 1 and 100");
    }
    const rows = this.database
      .prepare(`
        SELECT o.id AS outcomeId, o.signal_id AS signalId, s.token_key AS tokenKey,
               s.lifecycle, o.checkpoint_ms AS checkpointMs, o.due_at AS dueAt,
               o.attempt_count AS attemptCount, s.sent_at AS sentAt,
               s.sent_price AS sentPrice, s.pool_baseline_json AS poolBaselineJson
        FROM signal_outcomes o
        JOIN signals s ON s.id = o.signal_id
        WHERE o.state = 'pending'
          AND o.due_at <= ?
          AND COALESCE(o.next_attempt_at, o.due_at) <= ?
          AND s.state IN ('sent', 'confirmed')
        ORDER BY o.due_at, o.id
        LIMIT ?
      `)
      .all(now, now, limit) as Array<
      Omit<PendingOutcomeJob, "poolBaseline"> & { poolBaselineJson: string | null }
    >;
    return rows.map(({ poolBaselineJson, ...row }) => ({
      ...row,
      poolBaseline: poolBaselineJson === null ? null : (JSON.parse(poolBaselineJson) as unknown),
    }));
  }

  public savePoolBaseline(tokenKey: string, pool: unknown, now: number): boolean {
    const result = this.database
      .prepare(`
        UPDATE signals SET pool_baseline_json = ?, updated_at = ?
        WHERE token_key = ? AND state IN ('sent', 'confirmed')
      `)
      .run(serializeJson(pool), now, tokenKey);
    return result.changes === 1;
  }

  public getRealtimePrices(tokenKey: string, from: number, to: number): readonly {
    readonly capturedAt: number;
    readonly price: number;
  }[] {
    const rows = this.database
      .prepare(`
        SELECT captured_at AS capturedAt, payload_json AS payloadJson
        FROM token_snapshots
        WHERE token_key = ? AND captured_at >= ? AND captured_at <= ?
        ORDER BY captured_at, ingest_seq, id
      `)
      .all(tokenKey, from, to) as Array<{ capturedAt: number; payloadJson: string }>;
    const prices: Array<{ capturedAt: number; price: number }> = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      if (typeof payload.price === "number" && Number.isFinite(payload.price) && payload.price > 0) {
        prices.push({ capturedAt: row.capturedAt, price: payload.price });
      }
    }
    return prices;
  }

  public getTrenchesEvidence(tokenKey: string, from: number, to: number): readonly {
    readonly capturedAt: number;
    readonly payload: unknown;
  }[] {
    const rows = this.database
      .prepare(`
        SELECT captured_at AS capturedAt, payload_json AS payloadJson
        FROM token_snapshots
        WHERE token_key = ? AND source = 'trenches'
          AND captured_at >= ? AND captured_at <= ?
        ORDER BY captured_at, ingest_seq, id
      `)
      .all(tokenKey, from, to) as Array<{ capturedAt: number; payloadJson: string }>;
    return rows.map((row) => ({
      capturedAt: row.capturedAt,
      payload: JSON.parse(row.payloadJson) as unknown,
    }));
  }

  public listStatisticsSignals(from: number, to: number): readonly StatisticsSignalRow[] {
    const signals = this.database
      .prepare(`
        SELECT id AS signalId, token_key AS tokenKey, lifecycle, state,
               decision_json AS decisionJson, qualified_at AS qualifiedAt,
               security_completed_at AS securityCompletedAt, sent_at AS sentAt,
               confirmed_at AS confirmedAt
        FROM signals
        WHERE state IN ('sent', 'confirmed') AND sent_at >= ? AND sent_at < ?
        ORDER BY sent_at, id
      `)
      .all(from, to) as Array<
      Omit<StatisticsSignalRow, "decision" | "outcomes"> & { decisionJson: string }
    >;
    const outcomes = this.database.prepare(`
      SELECT checkpoint_ms AS checkpointMs, state, result_json AS resultJson
      FROM signal_outcomes WHERE signal_id = ? ORDER BY checkpoint_ms
    `);
    return signals.map(({ decisionJson, ...signal }) => ({
      ...signal,
      decision: JSON.parse(decisionJson) as unknown,
      outcomes: (outcomes.all(signal.signalId) as Array<{
        checkpointMs: number;
        state: OutcomeRecord["state"];
        resultJson: string | null;
      }>).map(({ resultJson, ...outcome }) => ({
        ...outcome,
        result: resultJson === null ? null : (JSON.parse(resultJson) as unknown),
      })),
    }));
  }

  public summarizeSignals(from: number, to: number): SignalStateSummary {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new RangeError("Signal summary range must be increasing");
    }
    const rows = this.database
      .prepare(`
        SELECT state, reason, COUNT(*) AS count
        FROM signals
        WHERE first_discovered_at >= ? AND first_discovered_at < ?
        GROUP BY state, reason
        ORDER BY state, reason
      `)
      .all(from, to) as Array<{ state: string; reason: string | null; count: number }>;
    const stateCounts: Record<string, number> = {};
    const reasonCounts: Record<string, number> = {};
    let candidates = 0;
    for (const row of rows) {
      candidates += row.count;
      stateCounts[row.state] = (stateCounts[row.state] ?? 0) + row.count;
      if (row.reason !== null) reasonCounts[row.reason] = (reasonCounts[row.reason] ?? 0) + row.count;
    }
    return { candidates, stateCounts, reasonCounts };
  }

  public listOperationalSignals(from: number, to: number): readonly OperationalSignalRow[] {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new RangeError("Operational metrics range must be increasing");
    }
    const rows = this.database
      .prepare(`
        SELECT s.token_key AS tokenKey, s.lifecycle, s.state, s.reason,
               s.decision_json AS decisionJson,
               MIN(t.source_captured_at) AS sourceCapturedAt,
               s.first_discovered_at AS firstDiscoveredAt,
               s.qualified_at AS qualifiedAt,
               s.security_completed_at AS securityCompletedAt,
               s.telegram_attempted_at AS telegramAttemptedAt,
               s.sent_at AS sentAt
        FROM signals s
        LEFT JOIN token_snapshots t ON t.token_key = s.token_key
          AND t.captured_at <= COALESCE(s.sent_at, s.updated_at)
          AND t.source_captured_at >= s.first_discovered_at
        WHERE s.first_discovered_at >= ? AND s.first_discovered_at < ?
        GROUP BY s.id
        ORDER BY s.first_discovered_at, s.id
      `)
      .all(from, to) as Array<Omit<OperationalSignalRow, "decision"> & { decisionJson: string }>;
    return rows.map(({ decisionJson, ...row }) => ({
      ...row,
      decision: JSON.parse(decisionJson) as unknown,
    }));
  }

  public countPendingOutcomes(): number {
    return (
      this.database
        .prepare("SELECT COUNT(*) AS count FROM signal_outcomes WHERE state = 'pending'")
        .get() as { count: number }
    ).count;
  }

  public claimDailyReport(localDate: string, now: number): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      throw new Error("Daily report date must use YYYY-MM-DD");
    }
    return this.database.transaction(() => {
      if (this.getRuntimeState<string>("last_daily_report_date") === localDate) {
        return false;
      }
      this.setRuntimeState("last_daily_report_date", localDate, now);
      return true;
    })();
  }

  public setRuntimeState(key: string, value: unknown, now = Date.now()): void {
    this.database
      .prepare(`
        INSERT INTO runtime_state (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, serializeJson(value), now);
  }

  public incrementRuntimeCounter(key: string, now = Date.now()): number {
    return this.database.transaction(() => {
      const current = this.getRuntimeState<unknown>(key) ?? 0;
      if (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0) {
        throw new Error(`Invalid runtime counter ${key}`);
      }
      const next = current + 1;
      this.setRuntimeState(key, next, now);
      return next;
    })();
  }

  public getRuntimeState<T>(key: string): T | null {
    const row = this.database
      .prepare("SELECT value_json FROM runtime_state WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.value_json) as T);
  }

  public recoverStartupState(now = Date.now(), creatorCooldownMs = 30 * 60_000): RecoveredState {
    if (!Number.isSafeInteger(creatorCooldownMs) || creatorCooldownMs <= 0) {
      throw new RangeError("creatorCooldownMs must be a positive integer");
    }
    return this.database.transaction(() => {
      const converted = this.database
        .prepare(`
          UPDATE signals
          SET state = 'delivery_unknown', reason = 'restart_during_delivery', updated_at = ?
          WHERE state = 'delivery_pending' AND telegram_message_id IS NULL
        `)
        .run(now).changes;

      const blockedTokens = this.database
        .prepare(`
          SELECT token_key AS tokenKey, state, telegram_message_id AS telegramMessageId
          FROM signals
          WHERE state IN ('delivery_pending', 'delivery_unknown', 'sent', 'confirmed')
          ORDER BY token_key
        `)
        .all() as Array<{
        tokenKey: string;
        state: SignalState;
        telegramMessageId: number | null;
      }>;
      const recentSent = this.database
        .prepare(`
          SELECT token_key AS tokenKey, creator_address AS creatorAddress, sent_at AS sentAt,
                 priority
          FROM signals
          WHERE state IN ('sent', 'confirmed') AND sent_at >= ?
          ORDER BY sent_at
        `)
        .all(now - 60_000) as Array<{
        tokenKey: string;
          creatorAddress: string | null;
          sentAt: number;
          priority: "normal" | "high";
      }>;
      const creatorCooldowns = this.database
        .prepare(`
          SELECT creator_address AS creatorAddress, MAX(sent_at) AS sentAt
          FROM signals
          WHERE state IN ('sent', 'confirmed')
            AND creator_address IS NOT NULL
            AND sent_at >= ?
          GROUP BY creator_address
          ORDER BY creator_address
        `)
        .all(now - creatorCooldownMs) as Array<{
        creatorAddress: string;
        sentAt: number;
      }>;
      const pendingOutcomes = this.database
        .prepare(`
          SELECT id, signal_id AS signalId, checkpoint_ms AS checkpointMs, due_at AS dueAt,
                 attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt
          FROM signal_outcomes WHERE state = 'pending' ORDER BY due_at, id
        `)
        .all() as RecoveredState["pendingOutcomes"];

      const cooldownUntil = this.getRuntimeState<unknown>("gmgn_cooldown_until");
      if (
        cooldownUntil !== null &&
        (typeof cooldownUntil !== "number" || !Number.isSafeInteger(cooldownUntil))
      ) {
        throw new Error("Invalid gmgn_cooldown_until in runtime_state");
      }
      const lastDailyReportDate = this.getRuntimeState<unknown>("last_daily_report_date");
      if (
        lastDailyReportDate !== null &&
        (typeof lastDailyReportDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(lastDailyReportDate))
      ) {
        throw new Error("Invalid last_daily_report_date in runtime_state");
      }
      const nextIngestSeq = this.getRuntimeState<unknown>("next_ingest_seq") ?? 1;
      if (
        typeof nextIngestSeq !== "number" ||
        !Number.isSafeInteger(nextIngestSeq) ||
        nextIngestSeq < 1
      ) {
        throw new Error("Invalid next_ingest_seq in runtime_state");
      }

      return {
        blockedTokens,
        recentSent,
        creatorCooldowns,
        pendingOutcomes,
        cooldownUntil,
        lastDailyReportDate,
        nextIngestSeq,
        convertedPendingDeliveries: converted,
      };
    })();
  }

  private allocateIngestSeq(): number {
    const row = this.database
      .prepare("SELECT value_json FROM runtime_state WHERE key = 'next_ingest_seq'")
      .get() as { value_json: string } | undefined;
    const current: unknown = row === undefined ? 1 : JSON.parse(row.value_json);
    if (!Number.isSafeInteger(current) || typeof current !== "number" || current < 1) {
      throw new Error("Invalid next_ingest_seq in runtime_state");
    }
    this.setRuntimeState("next_ingest_seq", current + 1);
    return current;
  }
}
