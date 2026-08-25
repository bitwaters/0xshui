import type { SignalStatistics } from "../stats/index.js";

export interface ReplaySignal {
  readonly tokenKey: string;
  readonly qualifiedAt: number;
  readonly discoveredAt: number;
  readonly lifecycle: "curve" | "graduated";
  readonly trigger: "curve_acceleration" | "fast_rank" | "cross_source";
  readonly priority: "normal" | "high";
  readonly moveClass: string;
}

export interface ReplayDecision {
  readonly ingestSeq: number;
  readonly capturedAt: number;
  readonly tokenKey: string;
  readonly action: string;
  readonly reason: string | null;
}

export interface ReplayQualitySummary {
  readonly signals: number;
  readonly evaluated15: number;
  readonly evaluated1h: number;
  readonly multipleHitRates: Readonly<Record<string, number | null>>;
  readonly medianPeakMultiple: number | null;
  readonly medianTimeTo2xMs: number | null;
  readonly noTradeRate: number | null;
  readonly confirmedPoolRemovalRate: number | null;
  readonly graduationRate: number | null;
  readonly medianMfe15: number | null;
  readonly medianMae15: number | null;
  readonly medianLatencyMs: number | null;
  readonly coverage15: number | null;
}

export interface ReplayReport {
  readonly configVersion: number;
  readonly from: number;
  readonly to: number;
  readonly eventCount: number;
  readonly candidateCount: number;
  readonly signalCount: number;
  readonly confirmationCount: number;
  readonly actionCounts: Readonly<Record<string, number>>;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly actualCandidateCount: number;
  readonly actualStateCounts: Readonly<Record<string, number>>;
  readonly actualReasonCounts: Readonly<Record<string, number>>;
  readonly upstreamFilterVersions: readonly string[];
  readonly adapterVersions: readonly string[];
  readonly samplingLevels: readonly string[];
  readonly signals: readonly ReplaySignal[];
  readonly decisions: readonly ReplayDecision[];
  readonly replaySelectedQuality: ReplayQualitySummary;
  readonly actualQuality: ReplayQualitySummary;
  readonly researchSampleCount: number;
  readonly researchSelectedCount: number;
  readonly researchSelectedQuality: ReplayQualitySummary;
  readonly scopeLimitations: readonly string[];
}

export function qualitySummary(stats: SignalStatistics): ReplayQualitySummary {
  return {
    signals: stats.signals,
    evaluated15: stats.evaluated15,
    evaluated1h: stats.evaluated1h,
    multipleHitRates: Object.fromEntries(
      stats.multipleHits.map((hit) => [`${hit.multiple}x`, hit.rate]),
    ),
    medianPeakMultiple: stats.medianPeakMultiple,
    medianTimeTo2xMs: stats.medianTimeTo2xMs,
    noTradeRate: stats.noTradeRate,
    confirmedPoolRemovalRate: stats.confirmedPoolRemovalRate,
    graduationRate: stats.curveGraduationRate,
    medianMfe15: stats.medianMfe15,
    medianMae15: stats.medianMae15,
    medianLatencyMs: stats.medianLatencyMs,
    coverage15: stats.coverage15,
  };
}
