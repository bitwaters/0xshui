export type SnapshotSource = "trenches" | "rank_1m" | "rank_5m";
export type SnapshotEventType = "enter" | "update" | "exit";
export type SamplingLevel = "high" | "ordinary";
export type SecurityStatus = "passed" | "rejected" | "failed";
export type SignalLifecycle = "curve" | "graduated";
export type SignalPriority = "normal" | "high";
export type CandidateState =
  | "observing"
  | "security_pending"
  | "qualified"
  | "rejected"
  | "cancelled"
  | "suppressed";
export type DeliveryState = "delivery_pending" | "delivery_unknown" | "sent" | "confirmed";
export type SignalState = CandidateState | DeliveryState;
export type OutcomeState =
  | "pending"
  | "completed"
  | "no_trade"
  | "pool_removed"
  | "api_missing"
  | "retry_exhausted";

export interface SnapshotEvent {
  readonly tokenKey: string;
  readonly eventType: SnapshotEventType;
  readonly capturedAt: number;
  readonly sourceCapturedAt: number;
  readonly samplingLevel: SamplingLevel;
  readonly payload: unknown;
  readonly upstreamFilterVersion: string;
  readonly adapterVersion: string;
}

export interface SecurityEvent {
  readonly tokenKey: string;
  readonly capturedAt: number;
  readonly status: SecurityStatus;
  readonly reason?: string;
  readonly payload: unknown;
  readonly adapterVersion: string;
}

export interface CandidateDecision {
  readonly tokenKey: string;
  readonly creatorAddress?: string;
  readonly lifecycle: SignalLifecycle;
  readonly state: CandidateState;
  readonly reason?: string;
  readonly priority: SignalPriority;
  readonly configVersion: number;
  readonly decision: unknown;
  readonly firstDiscoveredAt: number;
  readonly qualifiedAt?: number;
  readonly securityCompletedAt?: number;
  readonly now: number;
}

export interface OutcomeRecord {
  readonly signalId: number;
  readonly checkpointMs: number;
  readonly dueAt: number;
  readonly state: OutcomeState;
  readonly attemptCount: number;
  readonly nextAttemptAt?: number;
  readonly result?: unknown;
  readonly completedAt?: number;
  readonly now: number;
}

export interface PendingOutcomeJob {
  readonly outcomeId: number;
  readonly signalId: number;
  readonly tokenKey: string;
  readonly lifecycle: SignalLifecycle;
  readonly checkpointMs: number;
  readonly dueAt: number;
  readonly attemptCount: number;
  readonly sentAt: number;
  readonly sentPrice: number | null;
  readonly poolBaseline: unknown | null;
  readonly snapshotFallbackOnly: boolean;
  readonly previousPoolRemoved: boolean;
}

export interface ResearchSampleInput {
  readonly tokenKey: string;
  readonly configVersion: number;
  readonly sampledAt: number;
  readonly lifecycle: SignalLifecycle;
  readonly baselinePrice: number;
  readonly feature: unknown;
  readonly detectorVersion: string;
  readonly upstreamFilterVersion: string;
  readonly adapterVersion: string;
  readonly outcomeCheckpointsMs: readonly number[];
}

export interface PendingResearchOutcomeJob {
  readonly outcomeId: number;
  readonly researchSampleId: number;
  readonly tokenKey: string;
  readonly lifecycle: SignalLifecycle;
  readonly checkpointMs: number;
  readonly dueAt: number;
  readonly attemptCount: number;
  readonly sampledAt: number;
  readonly baselinePrice: number;
  readonly snapshotFallbackOnly: boolean;
  readonly previousPoolRemoved: boolean;
}

export interface ResearchOutcomeRecord {
  readonly researchSampleId: number;
  readonly checkpointMs: number;
  readonly dueAt: number;
  readonly state: OutcomeState;
  readonly attemptCount: number;
  readonly nextAttemptAt?: number;
  readonly result?: unknown;
  readonly completedAt?: number;
  readonly now: number;
}

export interface ResearchSampleRow {
  readonly id: number;
  readonly tokenKey: string;
  readonly originalConfigVersion: number;
  readonly sampledAt: number;
  readonly lifecycle: SignalLifecycle;
  readonly baselinePrice: number;
  readonly feature: unknown;
  readonly detectorVersion: string;
  readonly upstreamFilterVersion: string;
  readonly adapterVersion: string;
  readonly outcomes: ReadonlyArray<{
    readonly checkpointMs: number;
    readonly state: OutcomeState;
    readonly result: unknown | null;
  }>;
}

export interface StatisticsSignalRow {
  readonly signalId: number;
  readonly configVersion: number;
  readonly tokenKey: string;
  readonly lifecycle: SignalLifecycle;
  readonly state: "sent" | "confirmed";
  readonly decision: unknown;
  readonly qualifiedAt: number | null;
  readonly securityCompletedAt: number | null;
  readonly sentAt: number;
  readonly confirmedAt: number | null;
  readonly outcomes: ReadonlyArray<{
    readonly checkpointMs: number;
    readonly state: OutcomeState;
    readonly result: unknown | null;
  }>;
}

export type ReplayEvent =
  | {
      readonly kind: "snapshot";
      readonly ingestSeq: number;
      readonly source: SnapshotSource;
      readonly tokenKey: string;
      readonly eventType: SnapshotEventType;
      readonly capturedAt: number;
      readonly sourceCapturedAt: number;
      readonly samplingLevel: SamplingLevel;
      readonly payload: unknown;
      readonly upstreamFilterVersion: string;
      readonly adapterVersion: string;
    }
  | {
      readonly kind: "security";
      readonly ingestSeq: number;
      readonly tokenKey: string;
      readonly capturedAt: number;
      readonly status: SecurityStatus;
      readonly reason: string | null;
      readonly payload: unknown;
      readonly adapterVersion: string;
    };

export interface StoredConfigVersion {
  readonly version: number;
  readonly config: unknown;
  readonly createdAt: number;
}

export interface SignalStateSummary {
  readonly candidates: number;
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly reasonCounts: Readonly<Record<string, number>>;
}

export interface OperationalSignalRow {
  readonly tokenKey: string;
  readonly configVersion: number;
  readonly lifecycle: SignalLifecycle;
  readonly state: SignalState;
  readonly reason: string | null;
  readonly decision: unknown;
  readonly sourceCapturedAt: number | null;
  readonly firstDiscoveredAt: number;
  readonly qualifiedAt: number | null;
  readonly securityCompletedAt: number | null;
  readonly telegramAttemptedAt: number | null;
  readonly sentAt: number | null;
}

export interface StoredDetectionState {
  readonly state: SignalState;
  readonly lifecycle: SignalLifecycle;
  readonly priority: SignalPriority;
  readonly decision: unknown;
  readonly firstDiscoveredAt: number;
  readonly qualifiedAt: number | null;
  readonly securityCompletedAt: number | null;
}

export interface RecoveredState {
  readonly blockedTokens: ReadonlyArray<{
    readonly tokenKey: string;
    readonly state: SignalState;
    readonly telegramMessageId: number | null;
  }>;
  readonly recentSent: ReadonlyArray<{
    readonly tokenKey: string;
    readonly creatorAddress: string | null;
    readonly sentAt: number;
    readonly priority: SignalPriority;
  }>;
  readonly creatorCooldowns: ReadonlyArray<{
    readonly creatorAddress: string;
    readonly sentAt: number;
  }>;
  readonly pendingOutcomes: ReadonlyArray<{
    readonly id: number;
    readonly signalId: number;
    readonly checkpointMs: number;
    readonly dueAt: number;
    readonly attemptCount: number;
    readonly nextAttemptAt: number | null;
  }>;
  readonly cooldownUntil: number | null;
  readonly lastDailyReportDate: string | null;
  readonly nextIngestSeq: number;
  readonly convertedPendingDeliveries: number;
}
