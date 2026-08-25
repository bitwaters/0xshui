import type { StatisticsSignalRow } from "../db/index.js";

const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_HOUR = 60 * 60_000;
const KNOWN_OUTCOME_STATES = new Set(["completed", "no_trade", "pool_removed"]);
const KNOWN_TRIGGERS = new Set(["curve_acceleration", "fast_rank", "cross_source"]);

export interface SourceStatistics {
  readonly source: string;
  readonly signals: number;
  readonly hit15: number;
  readonly eligible15: number;
  readonly eligible1h: number;
  readonly medianMfe: number | null;
  readonly medianMae: number | null;
  readonly averageLatencyMs: number | null;
}

export interface SignalStatistics {
  readonly signals: number;
  readonly due15: number;
  readonly due1h: number;
  readonly pending15: number;
  readonly evaluated15: number;
  readonly evaluated1h: number;
  readonly validSamples1h: number;
  readonly nextReviewAt: number;
  readonly reviewStage: "collecting" | "first_review" | "baseline";
  readonly hit15: number;
  readonly largeGain1h: number;
  readonly coverage15: number | null;
  readonly coverage1h: number | null;
  readonly hitRate15: number | null;
  readonly largeGainRate1h: number | null;
  readonly medianReturn1m: number | null;
  readonly medianReturn5m: number | null;
  readonly medianReturn15m: number | null;
  readonly medianReturn1h: number | null;
  readonly medianMfe15: number | null;
  readonly medianMae15: number | null;
  readonly medianMfe1h: number | null;
  readonly medianMae1h: number | null;
  readonly curveSignals: number;
  readonly graduatedCurves: number;
  readonly knownCurveGraduations: number;
  readonly curveGraduationRate: number | null;
  readonly confirmed: number;
  readonly confirmationRate: number | null;
  readonly medianLatencyMs: number | null;
  readonly sources: readonly SourceStatistics[];
}

interface ParsedResult {
  readonly return1m?: number;
  readonly return5m?: number;
  readonly return15m?: number;
  readonly return1h?: number;
  readonly mfe?: number;
  readonly mae?: number;
  readonly graduation?: "graduated" | "not_graduated" | "unknown";
}

function finiteField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseResult(value: unknown): ParsedResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const graduation = record.graduation;
  const return1m = finiteField(record, "return1m");
  const return5m = finiteField(record, "return5m");
  const return15m = finiteField(record, "return15m");
  const return1h = finiteField(record, "return1h");
  const mfe = finiteField(record, "mfe");
  const mae = finiteField(record, "mae");
  return {
    ...(return1m === undefined ? {} : { return1m }),
    ...(return5m === undefined ? {} : { return5m }),
    ...(return15m === undefined ? {} : { return15m }),
    ...(return1h === undefined ? {} : { return1h }),
    ...(mfe === undefined ? {} : { mfe }),
    ...(mae === undefined ? {} : { mae }),
    ...(graduation === "graduated" ||
    graduation === "not_graduated" ||
    graduation === "unknown"
      ? { graduation }
      : {}),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function triggerOf(decision: unknown): string {
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
    return "unknown";
  }
  const record = decision as Record<string, unknown>;
  if (typeof record.trigger === "string" && KNOWN_TRIGGERS.has(record.trigger)) {
    return record.trigger;
  }
  const evidence = record.evidence;
  if (
    typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence) &&
    typeof (evidence as Record<string, unknown>).trigger === "string" &&
    KNOWN_TRIGGERS.has((evidence as Record<string, unknown>).trigger as string)
  ) {
    return (evidence as Record<string, unknown>).trigger as string;
  }
  return "unknown";
}

function outcomeAt(signal: StatisticsSignalRow, checkpointMs: number) {
  return signal.outcomes.find((outcome) => outcome.checkpointMs === checkpointMs);
}

export function aggregateStatistics(
  signals: readonly StatisticsSignalRow[],
  now: number,
  hitGain = 0.3,
  largeGain = 1,
): SignalStatistics {
  const fifteenReturns: number[] = [];
  const oneMinuteReturns: number[] = [];
  const fiveMinuteReturns: number[] = [];
  const oneHourReturns: number[] = [];
  const mfe15: number[] = [];
  const mae15: number[] = [];
  const mfe1h: number[] = [];
  const mae1h: number[] = [];
  const latencies: number[] = [];
  let due15 = 0;
  let due1h = 0;
  let evaluated15 = 0;
  let evaluated1h = 0;
  let hit15 = 0;
  let largeGain1h = 0;
  let graduatedCurves = 0;
  let knownCurveGraduations = 0;
  const bySource = new Map<string, StatisticsSignalRow[]>();

  for (const signal of signals) {
    const trigger = triggerOf(signal.decision);
    bySource.set(trigger, [...(bySource.get(trigger) ?? []), signal]);
    if (signal.state === "confirmed") {
      bySource.set("double_confirmation", [
        ...(bySource.get("double_confirmation") ?? []),
        signal,
      ]);
    }
    if (signal.qualifiedAt !== null && signal.sentAt >= signal.qualifiedAt) {
      latencies.push(signal.sentAt - signal.qualifiedAt);
    }
    const outcome15 = outcomeAt(signal, FIFTEEN_MINUTES);
    if (signal.sentAt + FIFTEEN_MINUTES <= now) {
      due15 += 1;
      if (outcome15 !== undefined && KNOWN_OUTCOME_STATES.has(outcome15.state)) {
        evaluated15 += 1;
        const result = parseResult(outcome15.result);
        if ((result.mfe ?? -Infinity) >= hitGain) {
          hit15 += 1;
        }
        if (result.return1m !== undefined) oneMinuteReturns.push(result.return1m);
        if (result.return5m !== undefined) fiveMinuteReturns.push(result.return5m);
        if (result.return15m !== undefined) fifteenReturns.push(result.return15m);
        if (result.mfe !== undefined) mfe15.push(result.mfe);
        if (result.mae !== undefined) mae15.push(result.mae);
      }
    }
    const outcome1h = outcomeAt(signal, ONE_HOUR);
    if (signal.sentAt + ONE_HOUR <= now) {
      due1h += 1;
      if (outcome1h !== undefined && KNOWN_OUTCOME_STATES.has(outcome1h.state)) {
        evaluated1h += 1;
        const result = parseResult(outcome1h.result);
        if ((result.mfe ?? -Infinity) >= largeGain) {
          largeGain1h += 1;
        }
        if (result.return1h !== undefined) oneHourReturns.push(result.return1h);
        if (result.mfe !== undefined) mfe1h.push(result.mfe);
        if (result.mae !== undefined) mae1h.push(result.mae);
        if (signal.lifecycle === "curve" && result.graduation !== "unknown") {
          if (result.graduation === "graduated") graduatedCurves += 1;
          if (result.graduation !== undefined) knownCurveGraduations += 1;
        }
      }
    }
  }

  const sourceStats = [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, rows]): SourceStatistics => {
      const sourceMfe: number[] = [];
      const sourceMae: number[] = [];
      const sourceLatencies: number[] = [];
      let eligible15 = 0;
      let eligible1h = 0;
      let sourceHits = 0;
      for (const row of rows) {
        const outcome = outcomeAt(row, FIFTEEN_MINUTES);
        if (outcome !== undefined && KNOWN_OUTCOME_STATES.has(outcome.state)) {
          eligible15 += 1;
          const result = parseResult(outcome.result);
          if ((result.mfe ?? -Infinity) >= hitGain) sourceHits += 1;
          if (result.mfe !== undefined) sourceMfe.push(result.mfe);
          if (result.mae !== undefined) sourceMae.push(result.mae);
        }
        const outcome1h = outcomeAt(row, ONE_HOUR);
        if (outcome1h !== undefined && KNOWN_OUTCOME_STATES.has(outcome1h.state)) {
          eligible1h += 1;
        }
        if (row.qualifiedAt !== null && row.sentAt >= row.qualifiedAt) {
          sourceLatencies.push(row.sentAt - row.qualifiedAt);
        }
      }
      return {
        source,
        signals: rows.length,
        hit15: sourceHits,
        eligible15,
        eligible1h,
        medianMfe: median(sourceMfe),
        medianMae: median(sourceMae),
        averageLatencyMs: average(sourceLatencies),
      };
    });
  const curveSignals = signals.filter((signal) => signal.lifecycle === "curve").length;
  const confirmed = signals.filter((signal) => signal.state === "confirmed").length;
  const nextReviewAt =
    evaluated1h < 30
      ? 30
      : evaluated1h < 100
        ? 100
        : (Math.floor(evaluated1h / 50) + 1) * 50;
  return {
    signals: signals.length,
    due15,
    due1h,
    pending15: signals.length - due15,
    evaluated15,
    evaluated1h,
    validSamples1h: evaluated1h,
    nextReviewAt,
    reviewStage: evaluated1h >= 100 ? "baseline" : evaluated1h >= 30 ? "first_review" : "collecting",
    hit15,
    largeGain1h,
    coverage15: due15 === 0 ? null : evaluated15 / due15,
    coverage1h: due1h === 0 ? null : evaluated1h / due1h,
    hitRate15: evaluated15 === 0 ? null : hit15 / evaluated15,
    largeGainRate1h: evaluated1h === 0 ? null : largeGain1h / evaluated1h,
    medianReturn1m: median(oneMinuteReturns),
    medianReturn5m: median(fiveMinuteReturns),
    medianReturn15m: median(fifteenReturns),
    medianReturn1h: median(oneHourReturns),
    medianMfe15: median(mfe15),
    medianMae15: median(mae15),
    medianMfe1h: median(mfe1h),
    medianMae1h: median(mae1h),
    curveSignals,
    graduatedCurves,
    knownCurveGraduations,
    curveGraduationRate:
      knownCurveGraduations === 0 ? null : graduatedCurves / knownCurveGraduations,
    confirmed,
    confirmationRate: signals.length === 0 ? null : confirmed / signals.length,
    medianLatencyMs: median(latencies),
    sources: sourceStats,
  };
}
