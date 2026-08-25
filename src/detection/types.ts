import type { AppConfig } from "../config/index.js";
import type {
  RankToken,
  SecuritySnapshot,
  TrenchesToken,
} from "../gmgn/index.js";
import type { SignalPriority, SignalState } from "../db/index.js";

export const DETECTOR_VERSION = "bsc-detector-v1";

export type TriggerKind =
  | "curve_acceleration"
  | "fast_rank"
  | "cross_source"
  | "mature_momentum";
export type MoveClass = "normal" | "fast_rise" | "observation_only" | "unknown";
export type DetectorAction =
  | "observe"
  | "security_pending"
  | "rejected"
  | "cancelled"
  | "suppressed"
  | "qualified"
  | "confirmed"
  | "no_change";

export interface Observation<T> {
  readonly capturedAt: number;
  readonly value: T | null;
}

export interface DetectorMarket {
  readonly trenches: readonly Observation<TrenchesToken>[];
  readonly rank1m: readonly Observation<RankToken>[];
  readonly rank5m: readonly Observation<RankToken>[];
  readonly current?: {
    readonly trench?: TrenchesToken;
    readonly rank1m?: RankToken;
    readonly rank5m?: RankToken;
  };
  readonly currentCapturedAt?: Partial<
    Readonly<Record<"trenches" | "rank_1m" | "rank_5m", number>>
  >;
  readonly sourceFresh: Readonly<Record<"trenches" | "rank_1m" | "rank_5m", boolean>>;
  readonly rank1mMissingSuccesses?: number;
}

export interface SecurityObservation {
  readonly capturedAt: number;
  readonly value: SecuritySnapshot;
}

export interface DiscoveryReference {
  readonly discoveredAt: number;
  readonly price?: number;
  readonly marketCap?: number;
}

export interface CandidateReference {
  readonly trigger: TriggerKind;
  readonly lifecycle: "curve" | "graduated";
  readonly priority: SignalPriority;
  readonly qualifiedAt: number;
  readonly rank1m?: number;
  readonly rank5m?: number;
  readonly rank1Swaps?: number;
  readonly rank1HolderCount?: number;
  readonly curveSwapsTotal?: number;
  readonly curveHolderCount?: number;
  readonly bondingProgress?: number;
  readonly curveNetBuyTotal?: number;
  readonly securityPassedAt?: number;
}

export interface RecentSignal {
  readonly tokenKey: string;
  readonly creatorAddress?: string;
  readonly sentAt: number;
  readonly priority: SignalPriority;
}

export interface DetectorInput {
  readonly version: typeof DETECTOR_VERSION;
  readonly tokenKey: string;
  readonly now: number;
  readonly configVersion: number;
  readonly config: AppConfig;
  readonly state: SignalState;
  readonly market: DetectorMarket;
  readonly security?: SecurityObservation;
  readonly discovery: DiscoveryReference;
  readonly candidate?: CandidateReference;
  readonly recentSignals?: readonly RecentSignal[];
}

export interface TriggerEvidence {
  readonly trigger: TriggerKind;
  readonly lifecycle: "curve" | "graduated";
  readonly priority: SignalPriority;
  readonly currentPrice?: number;
  readonly currentMarketCap?: number;
  readonly creatorAddress?: string;
  readonly reference: CandidateReference;
}

export interface DetectorDecision {
  readonly version: typeof DETECTOR_VERSION;
  readonly tokenKey: string;
  readonly action: DetectorAction;
  readonly nextState: SignalState;
  readonly reason?: string;
  readonly preheatSecurity: boolean;
  readonly evidence?: TriggerEvidence;
  readonly moveClass?: MoveClass;
}

export interface SafetyResult {
  readonly status: "pass" | "wait" | "reject";
  readonly reason?: string;
}

export interface QualifiedCandidate {
  readonly tokenKey: string;
  readonly creatorAddress?: string;
  readonly priority: SignalPriority;
  readonly triggeredAt: number;
}

export interface NoiseSelection {
  readonly accepted: readonly QualifiedCandidate[];
  readonly suppressed: ReadonlyArray<QualifiedCandidate & { readonly reason: string }>;
}
