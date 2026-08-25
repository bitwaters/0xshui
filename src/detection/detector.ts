import type { SignalState } from "../db/index.js";
import type { RankToken, RiskFields, TrenchesToken } from "../gmgn/index.js";
import { selectWithinNoiseLimits } from "./noise.js";
import { evaluateSafety } from "./safety.js";
import {
  DETECTOR_VERSION,
  type CandidateReference,
  type DetectorDecision,
  type DetectorInput,
  type MoveClass,
  type Observation,
  type TriggerEvidence,
} from "./types.js";

const TERMINAL_FIRST_SIGNAL_STATES = new Set<SignalState>([
  "delivery_pending",
  "delivery_unknown",
  "confirmed",
]);
const BSC_TOKEN_KEY = /^0x[0-9a-f]{40}$/;

const UNSENT_TRANSITIONS: readonly SignalState[] = [
  "observing",
  "security_pending",
  "qualified",
  "rejected",
  "cancelled",
  "suppressed",
];

const TRANSITIONS: Readonly<Record<SignalState, readonly SignalState[]>> = {
  observing: UNSENT_TRANSITIONS,
  security_pending: UNSENT_TRANSITIONS,
  qualified: [...UNSENT_TRANSITIONS, "delivery_pending"],
  rejected: UNSENT_TRANSITIONS,
  cancelled: UNSENT_TRANSITIONS,
  suppressed: UNSENT_TRANSITIONS,
  delivery_pending: ["delivery_pending", "delivery_unknown", "sent"],
  delivery_unknown: ["delivery_unknown"],
  sent: ["sent", "confirmed"],
  confirmed: ["confirmed"],
};

export function canTransitionSignalState(from: SignalState, to: SignalState): boolean {
  return TRANSITIONS[from].includes(to);
}

function validateDetectorInput(input: DetectorInput): void {
  if (!BSC_TOKEN_KEY.test(input.tokenKey)) {
    throw new Error("Detector tokenKey must be a normalized BSC address");
  }
  if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.configVersion) || input.configVersion < 1) {
    throw new Error("Detector time and config version must be positive safe integers");
  }
  if (input.discovery.discoveredAt > input.now) {
    throw new Error("Detector discovery time cannot be in the future");
  }
  if (
    (input.market.rank1mMissingSuccesses !== undefined &&
      (!Number.isSafeInteger(input.market.rank1mMissingSuccesses) ||
        input.market.rank1mMissingSuccesses < 0)) ||
    (input.state === "security_pending" && input.candidate === undefined) ||
    (input.candidate !== undefined && input.candidate.qualifiedAt > input.now)
  ) {
    throw new Error("Detector candidate and missing-rank state are inconsistent");
  }
  const histories = [
    ...input.market.trenches,
    ...input.market.rank1m,
    ...input.market.rank5m,
  ];
  for (const item of histories) {
    if (!Number.isSafeInteger(item.capturedAt) || item.capturedAt < 0) {
      throw new Error("Detector observation time must be a non-negative safe integer");
    }
    if (item.value !== null && item.value.tokenKey !== input.tokenKey) {
      throw new Error("Detector observation token does not match tokenKey");
    }
  }
  if (
    input.market.rank1m.some((item) => item.value !== null && item.value.interval !== "1m") ||
    input.market.rank5m.some((item) => item.value !== null && item.value.interval !== "5m")
  ) {
    throw new Error("Detector Rank observation interval does not match its source");
  }
  if (input.security !== undefined && input.security.value.tokenKey !== input.tokenKey) {
    throw new Error("Detector Security token does not match tokenKey");
  }
}

function ordered<T>(observations: readonly Observation<T>[]): readonly Observation<T>[] {
  return [...observations].sort((left, right) => left.capturedAt - right.capturedAt);
}

function activeTail<T>(observations: readonly Observation<T>[]): readonly Observation<T>[] {
  const values = ordered(observations);
  let start = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]?.value === null) {
      start = index + 1;
    }
  }
  return values.slice(start).filter((item) => item.value !== null);
}

function freshTail<T>(
  observations: readonly Observation<T>[],
  now: number,
  windowMs: number,
): readonly Observation<T>[] {
  return activeTail(observations).filter(
    (item) => item.capturedAt <= now && item.capturedAt >= now - windowMs,
  );
}

function valueOf<T>(observation: Observation<T> | undefined): T | undefined {
  return observation?.value ?? undefined;
}

function latest<T>(observations: readonly Observation<T>[]): T | undefined {
  return valueOf(activeTail(observations).at(-1));
}

function currentSources(input: DetectorInput): {
  readonly trench?: TrenchesToken;
  readonly rank1?: RankToken;
  readonly rank5?: RankToken;
} {
  const trench = latest(input.market.trenches);
  const rank1 = latest(input.market.rank1m);
  const rank5 = latest(input.market.rank5m);
  return {
    ...(trench === undefined ? {} : { trench }),
    ...(rank1 === undefined ? {} : { rank1 }),
    ...(rank5 === undefined ? {} : { rank5 }),
  };
}

function makeReference(
  input: DetectorInput,
  trigger: TriggerEvidence["trigger"],
  lifecycle: TriggerEvidence["lifecycle"],
  priority: TriggerEvidence["priority"],
  rank1?: RankToken,
  rank5?: RankToken,
  trench?: TrenchesToken,
): CandidateReference {
  return {
    trigger,
    lifecycle,
    priority,
    qualifiedAt: input.now,
    ...(rank1 === undefined
      ? {}
      : {
          rank1m: rank1.rank,
          rank1Swaps: rank1.swaps,
          rank1HolderCount: rank1.holderCount,
        }),
    ...(rank5 === undefined ? {} : { rank5m: rank5.rank }),
    ...(trench?.curveSwapsTotal === undefined
      ? {}
      : { curveSwapsTotal: trench.curveSwapsTotal }),
    ...(trench?.holderCount === undefined ? {} : { curveHolderCount: trench.holderCount }),
    ...(trench?.bondingProgress === undefined ? {} : { bondingProgress: trench.bondingProgress }),
    ...(trench?.curveNetBuyTotal === undefined
      ? {}
      : { curveNetBuyTotal: trench.curveNetBuyTotal }),
  };
}

function evidence(
  input: DetectorInput,
  trigger: TriggerEvidence["trigger"],
  priority: TriggerEvidence["priority"],
): TriggerEvidence {
  const { trench, rank1, rank5 } = currentSources(input);
  const lifecycle =
    trench !== undefined && trench.stage !== "completed" ? "curve" : "graduated";
  const currentPrice =
    lifecycle === "curve" ? (trench?.price ?? rank1?.price) : (rank1?.price ?? trench?.price);
  const currentMarketCap =
    lifecycle === "curve"
      ? (trench?.marketCap ?? rank1?.marketCap)
      : (rank1?.marketCap ?? trench?.marketCap);
  const creatorAddress =
    lifecycle === "curve"
      ? (trench?.creatorAddress ?? rank1?.creatorAddress)
      : (rank1?.creatorAddress ?? trench?.creatorAddress);
  return {
    trigger,
    lifecycle,
    priority,
    reference: makeReference(input, trigger, lifecycle, priority, rank1, rank5, trench),
    ...(currentPrice === undefined ? {} : { currentPrice }),
    ...(currentMarketCap === undefined ? {} : { currentMarketCap }),
    ...(creatorAddress === undefined ? {} : { creatorAddress }),
  };
}

function detectCurve(input: DetectorInput): TriggerEvidence | null {
  if (!input.market.sourceFresh.trenches) {
    return null;
  }
  const points = freshTail(input.market.trenches, input.now, input.config.curve_trigger.window);
  if (points.length < 2) {
    return null;
  }
  let baselineIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    const prior = valueOf(points[index - 1]);
    const current = valueOf(points[index]);
    if (
      prior?.curveSwapsTotal !== undefined &&
      current?.curveSwapsTotal !== undefined &&
      (current.curveSwapsTotal < prior.curveSwapsTotal ||
        (prior.curveNetBuyTotal !== undefined &&
          current.curveNetBuyTotal !== undefined &&
          current.curveNetBuyTotal < prior.curveNetBuyTotal))
    ) {
      baselineIndex = index;
    }
  }
  const baseline = valueOf(points[baselineIndex]);
  const current = valueOf(points.at(-1));
  if (
    baseline === undefined ||
    current === undefined ||
    baseline === current ||
    baseline.stage === "completed" ||
    current.stage === "completed" ||
    baseline.curveSwapsTotal === undefined ||
    current.curveSwapsTotal === undefined ||
    baseline.curveNetBuyTotal === undefined ||
    current.curveNetBuyTotal === undefined ||
    baseline.bondingProgress === undefined ||
    current.bondingProgress === undefined ||
    baseline.holderCount === undefined ||
    current.holderCount === undefined
  ) {
    return null;
  }
  const trigger = input.config.curve_trigger;
  if (
    current.curveSwapsTotal < trigger.min_curve_swaps_total ||
    current.holderCount < trigger.min_holders ||
    current.curveNetBuyTotal <= 0 ||
    current.bondingProgress - baseline.bondingProgress < trigger.min_progress_growth ||
    current.holderCount - baseline.holderCount < trigger.min_holder_growth ||
    current.curveNetBuyTotal <= baseline.curveNetBuyTotal ||
    (current.curveSwapsTotal - baseline.curveSwapsTotal < trigger.min_curve_swap_growth &&
      (current.smartDegenCount ?? 0) < 1)
  ) {
    return null;
  }
  return evidence(input, "curve_acceleration", "normal");
}

function detectFastRank(input: DetectorInput): TriggerEvidence | null {
  if (!input.market.sourceFresh.rank_1m) {
    return null;
  }
  const points = freshTail(input.market.rank1m, input.now, input.config.fast_rank_trigger.window);
  if (points.length < input.config.fast_rank_trigger.min_fresh_snapshots) {
    return null;
  }
  const baseline = valueOf(points[0]);
  const current = valueOf(points.at(-1));
  if (baseline === undefined || current === undefined) {
    return null;
  }
  const trenchPresent =
    input.market.sourceFresh.trenches && latest(input.market.trenches) !== undefined;
  const smartMoneyIncreased =
    baseline.smartDegenCount !== undefined &&
    current.smartDegenCount !== undefined &&
    current.smartDegenCount > baseline.smartDegenCount;
  if (
    current.rank > input.config.fast_rank_trigger.max_rank_1m ||
    baseline.rank - current.rank < input.config.fast_rank_trigger.min_rank_improvement ||
    current.buys <= current.sells ||
    current.holderCount - baseline.holderCount < 3 ||
    (!trenchPresent && !smartMoneyIncreased)
  ) {
    return null;
  }
  return evidence(input, "fast_rank", trenchPresent ? "high" : "normal");
}

function detectCrossSource(input: DetectorInput): TriggerEvidence | null {
  if (!input.market.sourceFresh.rank_1m) {
    return null;
  }
  const points = freshTail(input.market.rank1m, input.now, input.config.gmgn.source_max_age_for_trigger);
  if (points.length < 2) {
    return null;
  }
  const baseline = valueOf(points[0]);
  const current = valueOf(points.at(-1));
  if (baseline === undefined || current === undefined) {
    return null;
  }
  const trenchPresent =
    input.market.sourceFresh.trenches && latest(input.market.trenches) !== undefined;
  const rank5 = latest(input.market.rank5m);
  const rank5Present =
    input.market.sourceFresh.rank_5m &&
    rank5 !== undefined &&
    rank5.rank <= input.config.cross_source_trigger.max_rank_5m;
  if (
    current.rank > input.config.cross_source_trigger.max_rank_1m ||
    baseline.rank - current.rank < input.config.cross_source_trigger.min_rank_improvement ||
    current.buys <= current.sells ||
    (!trenchPresent && !rank5Present) ||
    (current.holderCount - baseline.holderCount < 3 && current.swaps - baseline.swaps < 10)
  ) {
    return null;
  }
  return evidence(input, "cross_source", trenchPresent ? "high" : "normal");
}

export function detectTrigger(input: DetectorInput): TriggerEvidence | null {
  return detectCurve(input) ?? detectFastRank(input) ?? detectCrossSource(input);
}

export function shouldPreheatSecurity(input: DetectorInput): boolean {
  const { trench, rank1 } = currentSources(input);
  const rankPreheat =
    input.market.sourceFresh.rank_1m &&
    rank1 !== undefined &&
    rank1.rank <= input.config.rank.security_preheat_rank_1m;
  const curvePreheat =
    input.market.sourceFresh.trenches &&
    trench !== undefined &&
    trench.stage !== "completed" &&
    trench.curveSwapsTotal !== undefined &&
    trench.curveSwapsTotal >= input.config.curve_preheat.min_curve_swaps_total &&
    trench.holderCount !== undefined &&
    trench.holderCount >= input.config.curve_preheat.min_holders &&
    trench.curveNetBuyTotal !== undefined &&
    trench.curveNetBuyTotal > 0;
  return rankPreheat || curvePreheat;
}

export function classifyMove(
  lifecycle: "curve" | "graduated",
  discovery: DetectorInput["discovery"],
  currentPrice?: number,
  currentMarketCap?: number,
): MoveClass {
  if (lifecycle === "curve") {
    if (
      discovery.marketCap === undefined ||
      !Number.isFinite(discovery.marketCap) ||
      discovery.marketCap <= 0 ||
      currentMarketCap === undefined ||
      !Number.isFinite(currentMarketCap) ||
      currentMarketCap < 0
    ) {
      return "unknown";
    }
    const multiple = currentMarketCap / discovery.marketCap;
    return multiple < 1.5 ? "normal" : multiple < 2 ? "fast_rise" : "observation_only";
  }
  if (
    discovery.price === undefined ||
    !Number.isFinite(discovery.price) ||
    discovery.price <= 0 ||
    currentPrice === undefined ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return "unknown";
  }
  const gain = currentPrice / discovery.price - 1;
  return gain < 0.3 ? "normal" : gain <= 1 ? "fast_rise" : "observation_only";
}

function confirmationEvidence(
  input: DetectorInput,
  reference: CandidateReference,
): boolean {
  if (!input.market.sourceFresh.rank_1m || !input.market.sourceFresh.rank_5m) {
    return false;
  }
  const window = input.config.gmgn.source_max_age_for_trigger;
  const rank1 = freshTail(input.market.rank1m, input.now, window);
  const rank5 = freshTail(input.market.rank5m, input.now, window);
  const needed = input.config.confirmation.min_fresh_snapshots;
  if (rank1.length < needed || rank5.length < needed) {
    return false;
  }
  const recent1 = rank1.slice(-needed).map((item) => valueOf(item));
  const recent5 = rank5.slice(-needed).map((item) => valueOf(item));
  if (recent1.some((item) => item === undefined) || recent5.some((item) => item === undefined)) {
    return false;
  }
  const current1 = recent1.at(-1) as RankToken;
  const current5 = recent5.at(-1) as RankToken;
  const first1 = valueOf(rank1[0]);
  const first5 = valueOf(rank5[0]);
  const baseRank1 = reference.rank1m ?? first1?.rank;
  const baseRank5 = reference.rank5m ?? first5?.rank;
  const baseHolders = reference.rank1HolderCount ?? first1?.holderCount;
  const baseSwaps = reference.rank1Swaps ?? first1?.swaps;
  return (
    recent1.every(
      (item) =>
        (item as RankToken).rank <= input.config.confirmation.max_rank_1m &&
        (item as RankToken).buys > (item as RankToken).sells,
    ) &&
    recent5.every((item) => (item as RankToken).rank <= input.config.confirmation.max_rank_5m) &&
    baseRank1 !== undefined &&
    baseRank5 !== undefined &&
    baseRank1 - current1.rank >= input.config.confirmation.min_rank_1m_improvement &&
    baseRank5 - current5.rank >= input.config.confirmation.min_rank_5m_improvement &&
    ((baseHolders !== undefined && current1.holderCount > baseHolders) ||
      (baseSwaps !== undefined && current1.swaps > baseSwaps))
  );
}

function directConfirmationReference(reference: CandidateReference): CandidateReference {
  return {
    trigger: reference.trigger,
    lifecycle: reference.lifecycle,
    priority: reference.priority,
    qualifiedAt: reference.qualifiedAt,
    ...(reference.securityPassedAt === undefined
      ? {}
      : { securityPassedAt: reference.securityPassedAt }),
  };
}

function cancellationReason(input: DetectorInput, reference: CandidateReference): string | null {
  const { trench, rank1 } = currentSources(input);
  if (reference.lifecycle === "curve") {
    if (
      trench !== undefined &&
      reference.bondingProgress !== undefined &&
      reference.curveHolderCount !== undefined &&
      reference.curveNetBuyTotal !== undefined &&
      (trench.bondingProgress ?? -Infinity) <= reference.bondingProgress &&
      (trench.holderCount ?? -Infinity) <= reference.curveHolderCount &&
      (trench.curveNetBuyTotal ?? -Infinity) <= reference.curveNetBuyTotal
    ) {
      return "curve_momentum_stopped";
    }
    return null;
  }
  if ((input.market.rank1mMissingSuccesses ?? 0) >= input.config.cancel.missing_rank_snapshots) {
    return "rank_left_top100";
  }
  if (rank1 === undefined) {
    return null;
  }
  const ranks = activeTail(input.market.rank1m)
    .filter((item) => item.capturedAt >= reference.qualifiedAt)
    .map((item) => valueOf(item)?.rank)
    .filter((rank): rank is number => rank !== undefined);
  const bestRank = Math.min(reference.rank1m ?? 101, ...ranks);
  if (rank1.rank - bestRank >= input.config.cancel.rank_fallback) {
    return "rank_fallback";
  }
  if (rank1.buys <= rank1.sells) {
    return "buy_pressure_lost";
  }
  if (
    reference.rank1Swaps !== undefined &&
    reference.rank1Swaps > 0 &&
    (reference.rank1Swaps - rank1.swaps) / reference.rank1Swaps >= input.config.cancel.swap_drop
  ) {
    return "swap_drop";
  }
  return null;
}

function sourceRiskFields(input: DetectorInput): {
  readonly risks: readonly RiskFields[];
  readonly sourceSecurity: readonly (RankToken | TrenchesToken)[];
  readonly hasSafeTrenches: boolean;
  readonly curveSource?: TrenchesToken;
} {
  const { trench, rank1, rank5 } = currentSources(input);
  const values = [trench, rank1, rank5].filter(
    (item): item is RankToken | TrenchesToken => item !== undefined,
  );
  return {
    risks: values,
    sourceSecurity: values,
    hasSafeTrenches: input.market.sourceFresh.trenches && trench !== undefined,
    ...(input.market.sourceFresh.trenches && trench !== undefined ? { curveSource: trench } : {}),
  };
}

export function passesResearchSafety(input: DetectorInput): boolean {
  if (input.security === undefined) return false;
  const { trench } = currentSources(input);
  const sourceFields = sourceRiskFields(input);
  const lifecycle = trench !== undefined && trench.stage !== "completed" ? "curve" : "graduated";
  return evaluateSafety({
    lifecycle,
    security: input.security.value,
    sources: sourceFields.risks,
    ...(sourceFields.curveSource === undefined ? {} : { curveSource: sourceFields.curveSource }),
    sourceSecurity: sourceFields.sourceSecurity,
    hasSafeTrenches: sourceFields.hasSafeTrenches,
    config: input.config.risk_filters,
  }).status === "pass";
}

function decision(
  input: DetectorInput,
  action: DetectorDecision["action"],
  nextState: SignalState,
  extras: Omit<DetectorDecision, "version" | "tokenKey" | "action" | "nextState">,
): DetectorDecision {
  if (!canTransitionSignalState(input.state, nextState)) {
    throw new Error(`Invalid detector state transition ${input.state} -> ${nextState}`);
  }
  return { version: DETECTOR_VERSION, tokenKey: input.tokenKey, action, nextState, ...extras };
}

export function evaluateDetector(input: DetectorInput): DetectorDecision {
  if (input.version !== DETECTOR_VERSION) {
    throw new Error(`Unsupported detector input version ${input.version as string}`);
  }
  validateDetectorInput(input);
  if (TERMINAL_FIRST_SIGNAL_STATES.has(input.state)) {
    return decision(input, "no_change", input.state, { preheatSecurity: false });
  }
  if (input.state === "sent") {
    if (input.candidate !== undefined && confirmationEvidence(input, input.candidate)) {
      return decision(input, "confirmed", "confirmed", {
        preheatSecurity: false,
        reason: "double_rank_confirmed",
      });
    }
    return decision(input, "no_change", "sent", { preheatSecurity: false });
  }

  const freshTrigger = detectTrigger(input);
  const trigger = freshTrigger ??
    (input.state === "security_pending" && input.candidate !== undefined
      ? evidence(input, input.candidate.trigger, input.candidate.priority)
      : null);
  const preheatSecurity = shouldPreheatSecurity(input);
  if (trigger === null) {
    return decision(input, "observe", input.state, { preheatSecurity });
  }

  const reference = freshTrigger?.reference ?? input.candidate ?? trigger.reference;
  if (
    input.security === undefined ||
    input.security.capturedAt > input.now ||
    input.now - input.security.capturedAt > input.config.gmgn.security_max_age_at_send
  ) {
    return decision(input, "security_pending", "security_pending", {
      preheatSecurity: true,
      reason: "fresh_security_required",
      evidence: { ...trigger, reference },
    });
  }

  const sourceFields = sourceRiskFields(input);
  const safety = evaluateSafety({
    lifecycle: reference.lifecycle,
    security: input.security.value,
    sources: sourceFields.risks,
    ...(sourceFields.curveSource === undefined ? {} : { curveSource: sourceFields.curveSource }),
    sourceSecurity: sourceFields.sourceSecurity,
    hasSafeTrenches: sourceFields.hasSafeTrenches,
    config: input.config.risk_filters,
  });
  if (safety.status === "wait") {
    return decision(input, "security_pending", "security_pending", {
      preheatSecurity: true,
      reason: safety.reason ?? "security_fields_missing",
      evidence: { ...trigger, reference },
    });
  }
  if (safety.status === "reject") {
    const degraded = reference.securityPassedAt !== undefined;
    return decision(input, degraded ? "cancelled" : "rejected", degraded ? "cancelled" : "rejected", {
      preheatSecurity: false,
      reason: degraded
        ? `security_degraded:${safety.reason ?? "unknown"}`
        : (safety.reason ?? "security_rejected"),
      evidence: { ...trigger, reference },
    });
  }

  const cancellation = input.candidate === undefined ? null : cancellationReason(input, reference);
  if (cancellation !== null) {
    return decision(input, "cancelled", "cancelled", {
      preheatSecurity: false,
      reason: cancellation,
      evidence: { ...trigger, reference },
    });
  }

  const passedReference: CandidateReference = {
    ...reference,
    securityPassedAt: input.security.capturedAt,
  };
  const directlyConfirmed = confirmationEvidence(
    input,
    input.candidate === undefined ? directConfirmationReference(passedReference) : passedReference,
  );
  const priority = directlyConfirmed ? "high" : trigger.priority;
  const selected = selectWithinNoiseLimits(
    [
      {
        tokenKey: input.tokenKey,
        priority,
        triggeredAt: passedReference.qualifiedAt,
        ...(trigger.creatorAddress === undefined ? {} : { creatorAddress: trigger.creatorAddress }),
      },
    ],
    input.recentSignals ?? [],
    input.now,
    input.config.noise,
  );
  const suppressed = selected.suppressed[0];
  if (suppressed !== undefined) {
    return decision(input, "suppressed", "suppressed", {
      preheatSecurity: false,
      reason: suppressed.reason,
      evidence: { ...trigger, priority, reference: passedReference },
    });
  }
  return decision(input, "qualified", "qualified", {
    preheatSecurity: false,
    reason: directlyConfirmed ? "direct_double_rank" : trigger.trigger,
    evidence: { ...trigger, priority, reference: passedReference },
    moveClass: classifyMove(
      passedReference.lifecycle,
      input.discovery,
      trigger.currentPrice,
      trigger.currentMarketCap,
    ),
  });
}
