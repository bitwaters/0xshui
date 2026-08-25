import type { AppConfig } from "../config/index.js";
import type {
  CandidateState,
  PersistenceRepository,
  SignalState,
} from "../db/index.js";
import {
  DETECTOR_VERSION,
  evaluateDetector,
  passesResearchSafety,
  shouldPreheatSecurity,
  type CandidateReference,
  type DetectorDecision,
  type DetectorInput,
  type DiscoveryReference,
  type Observation,
  type RecentSignal,
} from "../detection/index.js";
import type { RankToken, SecuritySnapshot, TrenchesToken } from "../gmgn/index.js";
import type { AppLogger } from "../logging/index.js";
import type { HealthMonitor } from "../operations/index.js";
import type { TokenWindowStore } from "../realtime/index.js";
import { buildResearchSample } from "../replay/index.js";
import type {
  FreshSignalCheck,
  SignalCardModel,
  TelegramPublisher,
} from "../telegram/index.js";

interface SecurityAccess {
  readonly preheat: (tokenKey: string) => Promise<SecuritySnapshot | null>;
  readonly getFreshForSend: (tokenKey: string) => Promise<SecuritySnapshot | null>;
  readonly getCached: (
    tokenKey: string,
  ) => { readonly snapshot: SecuritySnapshot; readonly capturedAt: number } | null;
}

interface EngineState {
  state: SignalState;
  readonly discovery: DiscoveryReference;
  candidate?: CandidateReference;
}

export interface SignalEngineOptions {
  readonly config: Readonly<AppConfig>;
  readonly configVersion: number;
  readonly repository: PersistenceRepository;
  readonly windowStore: TokenWindowStore;
  readonly security: SecurityAccess;
  readonly publisher?: TelegramPublisher;
  readonly logger: AppLogger;
  readonly health: HealthMonitor;
  readonly recoveredRecentSignals?: readonly RecentSignal[];
  readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function candidateFromDecision(value: unknown): CandidateReference | undefined {
  const root = record(value);
  const evidence = record(root?.evidence);
  const reference = record(evidence?.reference);
  if (
    reference === null ||
    (reference.trigger !== "curve_acceleration" &&
      reference.trigger !== "fast_rank" &&
      reference.trigger !== "cross_source") ||
    (reference.lifecycle !== "curve" && reference.lifecycle !== "graduated") ||
    (reference.priority !== "normal" && reference.priority !== "high") ||
    typeof reference.qualifiedAt !== "number"
  ) {
    return undefined;
  }
  return reference as unknown as CandidateReference;
}

function rankObservation(event: { readonly capturedAt: number; readonly eventType: string; readonly data: unknown }, interval: "1m" | "5m"): Observation<RankToken> | null {
  const payload = record(event.data);
  if (payload === null || payload.interval !== interval) return null;
  return {
    capturedAt: event.capturedAt,
    value: {
      ...payload,
      ...(event.eventType === "exit" ? { rank: 101 } : {}),
    } as unknown as RankToken,
  };
}

function trenchesObservation(event: { readonly capturedAt: number; readonly eventType: string; readonly data: unknown }): Observation<TrenchesToken> | null {
  if (event.eventType === "exit") return { capturedAt: event.capturedAt, value: null };
  const payload = record(event.data);
  return payload === null
    ? null
    : { capturedAt: event.capturedAt, value: payload as unknown as TrenchesToken };
}

export class SignalEngine {
  private readonly states = new Map<string, EngineState>();
  private readonly recentSignals: RecentSignal[];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => number;

  public constructor(private readonly options: SignalEngineOptions) {
    this.recentSignals = [...(options.recoveredRecentSignals ?? [])].map((signal) => ({
      ...signal,
      priority: signal.priority ?? "normal",
    }));
    this.now = options.now ?? Date.now;
  }

  public async processTokens(tokenKeys: readonly string[], now = this.now()): Promise<void> {
    for (const tokenKey of [...new Set(tokenKeys)].sort()) {
      await this.processToken(tokenKey, now);
    }
  }

  public processToken(tokenKey: string, now = this.now()): Promise<void> {
    const prior = this.locks.get(tokenKey) ?? Promise.resolve();
    const next = prior.then(() => this.evaluateAndAct(tokenKey, now));
    this.locks.set(tokenKey, next);
    return next.finally(() => {
      if (this.locks.get(tokenKey) === next) this.locks.delete(tokenKey);
    });
  }

  private async evaluateAndAct(tokenKey: string, now: number): Promise<void> {
    const input = this.inputFor(tokenKey, now);
    if (input === null) return;
    const result = evaluateDetector(input);
    this.persist(input, result, now);
    this.persistResearch(input, now);
    const state = this.states.get(tokenKey);
    if (state === undefined) return;
    state.state = result.nextState;
    if (result.evidence !== undefined) state.candidate = result.evidence.reference;
    if (result.preheatSecurity) {
      void this.options.security.preheat(tokenKey).catch(() => undefined);
    }
    if (result.action === "qualified") {
      this.options.logger.info("candidate_created", {
        token_key: tokenKey,
        trigger: result.evidence?.trigger,
        qualified_at: now,
      });
      if (this.options.publisher !== undefined) {
        const reservation: RecentSignal = {
          tokenKey,
          sentAt: now,
          priority: result.evidence?.priority ?? "normal",
          ...(result.evidence?.creatorAddress === undefined
            ? {}
            : { creatorAddress: result.evidence.creatorAddress }),
        };
        this.recentSignals.push(reservation);
        const published = await this.options.publisher.publish({
          tokenKey,
          recheck: () => this.recheck(tokenKey),
        });
        const persisted = this.options.repository.getDetectionState(tokenKey);
        if (persisted !== null) state.state = persisted.state;
        if (published.status === "sent") {
          this.options.health.markHealthy("telegram", this.now());
          this.options.logger.info("signal_sent", {
            token_key: tokenKey,
            telegram_message_id: published.messageId,
          });
          const evidence = result.evidence;
          if (evidence !== undefined) {
            this.removeRecent(reservation);
            this.recentSignals.push({
              tokenKey,
              sentAt: this.now(),
              priority: evidence.priority,
              ...(evidence.creatorAddress === undefined
                ? {}
                : { creatorAddress: evidence.creatorAddress }),
            });
          }
        } else if (published.status === "delivery_unknown") {
          this.options.health.markDegraded("telegram", this.now());
          this.options.logger.warn("delivery_unknown", {
            token_key: tokenKey,
            reason: published.reason,
          });
        } else if (published.status === "not_sent") {
          this.removeRecent(reservation);
          this.options.health.markDegraded("telegram", this.now());
        } else {
          this.removeRecent(reservation);
        }
      }
    } else if (result.action === "confirmed" && this.options.publisher !== undefined) {
      const card = this.cardFor(input, result, true);
      if (card !== null && (await this.options.publisher.confirm(tokenKey, card))) {
        state.state = "confirmed";
        this.options.logger.info("signal_updated", { token_key: tokenKey });
      }
    } else if (result.action === "rejected") {
      this.options.logger.info("candidate_rejected", { token_key: tokenKey, reason: result.reason });
    } else if (result.action === "cancelled") {
      this.options.logger.info("candidate_cancelled", { token_key: tokenKey, reason: result.reason });
    } else if (result.action === "suppressed") {
      this.options.logger.info("signal_suppressed", { token_key: tokenKey, reason: result.reason });
    }
  }

  private inputFor(tokenKey: string, now: number, excludeOwnRecent = false): DetectorInput | null {
    const events = this.options.windowStore.getEvents(tokenKey, now);
    const sourceEvents = events.filter((event) => event.source !== "security");
    if (sourceEvents.length === 0) return null;
    let state = this.states.get(tokenKey);
    if (state === undefined) {
      const stored = this.options.repository.getDetectionState(tokenKey);
      const first = sourceEvents[0];
      const payload = record(first?.data);
      const storedCandidate = candidateFromDecision(stored?.decision);
      state = {
        state:
          stored?.state === "security_pending" && storedCandidate === undefined
            ? "observing"
            : (stored?.state ?? "observing"),
        discovery: {
          discoveredAt: stored?.firstDiscoveredAt ?? first?.capturedAt ?? now,
          ...(typeof payload?.price === "number" ? { price: payload.price } : {}),
          ...(typeof payload?.marketCap === "number" ? { marketCap: payload.marketCap } : {}),
        },
        ...(storedCandidate === undefined ? {} : { candidate: storedCandidate }),
      };
      this.states.set(tokenKey, state);
    }
    const trenches = sourceEvents
      .filter((event) => event.source === "trenches")
      .map(trenchesObservation)
      .filter((item): item is Observation<TrenchesToken> => item !== null);
    const rank1m = sourceEvents
      .filter((event) => event.source === "rank_1m")
      .map((event) => rankObservation(event, "1m"))
      .filter((item): item is Observation<RankToken> => item !== null);
    const rank5m = sourceEvents
      .filter((event) => event.source === "rank_5m")
      .map((event) => rankObservation(event, "5m"))
      .filter((item): item is Observation<RankToken> => item !== null);
    const cached = this.options.security.getCached(tokenKey);
    return {
      version: DETECTOR_VERSION,
      tokenKey,
      now,
      configVersion: this.options.configVersion,
      config: this.options.config,
      state: state.state,
      market: {
        trenches,
        rank1m,
        rank5m,
        sourceFresh: {
          trenches: this.options.windowStore.isSourceFresh("trenches", now),
          rank_1m: this.options.windowStore.isSourceFresh("rank_1m", now),
          rank_5m: this.options.windowStore.isSourceFresh("rank_5m", now),
        },
        rank1mMissingSuccesses: rank1m.at(-1)?.value?.rank === 101 ? 1 : 0,
      },
      ...(cached === null ? {} : { security: { capturedAt: cached.capturedAt, value: cached.snapshot } }),
      discovery: state.discovery,
      ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
      recentSignals: excludeOwnRecent
        ? this.recentSignals.filter((signal) => signal.tokenKey !== tokenKey)
        : this.recentSignals,
    };
  }

  private persist(input: DetectorInput, result: DetectorDecision, now: number): void {
    const persistable = new Set<SignalState>([
      "observing",
      "security_pending",
      "qualified",
      "rejected",
      "cancelled",
      "suppressed",
    ]);
    if (!persistable.has(result.nextState)) return;
    const evidence = result.evidence;
    try {
      this.options.repository.upsertCandidateDecision({
        tokenKey: input.tokenKey,
        ...(evidence?.creatorAddress === undefined
          ? {}
          : { creatorAddress: evidence.creatorAddress }),
        lifecycle: evidence?.lifecycle ?? input.candidate?.lifecycle ?? "graduated",
        state: result.nextState as CandidateState,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        priority: evidence?.priority ?? input.candidate?.priority ?? "normal",
        configVersion: input.configVersion,
        decision: result,
        firstDiscoveredAt: input.discovery.discoveredAt,
        ...(evidence === undefined ? {} : { qualifiedAt: evidence.reference.qualifiedAt }),
        ...(input.security === undefined ? {} : { securityCompletedAt: input.security.capturedAt }),
        now,
      });
      this.options.health.markHealthy("storage", now);
    } catch (error) {
      this.options.health.markFailed("storage", now);
      this.options.logger.error("storage_failed", error, { phase: "candidate_persist" });
      throw error;
    }
  }

  private persistResearch(input: DetectorInput, now: number): void {
    if (!shouldPreheatSecurity(input) || !passesResearchSafety(input)) return;
    const sample = buildResearchSample(input);
    if (sample === null) return;
    try {
      const created = this.options.repository.createResearchSample({
        tokenKey: input.tokenKey,
        configVersion: input.configVersion,
        sampledAt: now,
        lifecycle: sample.lifecycle,
        baselinePrice: sample.baselinePrice,
        feature: sample.feature,
        detectorVersion: DETECTOR_VERSION,
        upstreamFilterVersion: "gmgn-safe-v1",
        adapterVersion: "gmgn-adapter-v1",
        outcomeCheckpointsMs: this.options.config.outcomes.checkpoints,
      });
      if (created) this.options.logger.info("research_sample_created");
    } catch (error) {
      this.options.health.markFailed("storage", now);
      this.options.logger.error("storage_failed", error, { phase: "research_sample" });
    }
  }

  private async recheck(tokenKey: string): Promise<FreshSignalCheck> {
    const fresh = await this.options.security.getFreshForSend(tokenKey);
    if (fresh === null) return { ok: false, reason: "security_unavailable" };
    const input = this.inputFor(tokenKey, this.now(), true);
    if (input === null) return { ok: false, reason: "market_missing" };
    const result = evaluateDetector(input);
    if (result.action !== "qualified") {
      this.persist(input, result, this.now());
      return { ok: false, reason: result.reason ?? "candidate_no_longer_qualified" };
    }
    const card = this.cardFor(input, result, false);
    return card === null ? { ok: false, reason: "card_data_missing" } : { ok: true, card };
  }

  private cardFor(
    input: DetectorInput,
    result: DetectorDecision,
    confirmed: boolean,
  ): SignalCardModel | null {
    const evidence = result.evidence;
    const reference = evidence?.reference ?? input.candidate;
    if (reference === undefined) return null;
    const latestRank1 = input.market.rank1m.at(-1)?.value ?? undefined;
    const latestRank5 = input.market.rank5m.at(-1)?.value ?? undefined;
    const latestTrench = input.market.trenches.at(-1)?.value ?? undefined;
    const name = latestRank1?.name ?? latestTrench?.name;
    const symbol = latestRank1?.symbol ?? latestTrench?.symbol;
    return {
      tokenKey: input.tokenKey,
      ...(name === undefined ? {} : { name }),
      ...(symbol === undefined ? {} : { symbol }),
      lifecycle: evidence?.lifecycle ?? reference.lifecycle,
      trigger: evidence?.trigger ?? reference.trigger,
      moveClass: result.moveClass ?? "unknown",
      ...(evidence?.currentPrice === undefined ? {} : { price: evidence.currentPrice }),
      ...(evidence?.currentMarketCap === undefined
        ? {}
        : { marketCap: evidence.currentMarketCap }),
      ...(latestRank1 === undefined || latestRank1.rank > 100
        ? {}
        : { rank1m: latestRank1.rank }),
      ...(latestRank5 === undefined || latestRank5.rank > 100
        ? {}
        : { rank5m: latestRank5.rank }),
      confirmed,
    };
  }

  private removeRecent(target: RecentSignal): void {
    const index = this.recentSignals.indexOf(target);
    if (index >= 0) this.recentSignals.splice(index, 1);
  }
}
