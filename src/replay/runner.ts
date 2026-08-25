import { parseAppConfig, type AppConfig } from "../config/index.js";
import type {
  PersistenceRepository,
  ReplayEvent,
  SignalState,
  StatisticsSignalRow,
} from "../db/index.js";
import {
  DETECTOR_VERSION,
  evaluateDetector,
  type CandidateReference,
  type DetectorMarket,
  type DiscoveryReference,
  type Observation,
  type RecentSignal,
} from "../detection/index.js";
import type { RankToken, SecuritySnapshot, TrenchesToken } from "../gmgn/index.js";
import { aggregateStatistics } from "../stats/index.js";
import {
  qualitySummary,
  type ReplayDecision,
  type ReplayReport,
  type ReplaySignal,
} from "./types.js";
import { evaluateResearchFeature } from "./research.js";

const HISTORY_MS = 60_000;
const HISTORY_LIMIT = 10;
const HOUR_MS = 60 * 60_000;
const BSC_ADDRESS = /^0x[0-9a-f]{40}$/;

interface TokenHistory {
  trenches: Array<Observation<TrenchesToken>>;
  rank1m: Array<Observation<RankToken>>;
  rank5m: Array<Observation<RankToken>>;
}

interface ReplayCurrentState {
  readonly trenches: Map<string, TrenchesToken>;
  readonly rank1m: Map<string, RankToken>;
  readonly rank5m: Map<string, RankToken>;
}

interface TokenState {
  state: SignalState;
  discovery: DiscoveryReference;
  candidate?: CandidateReference;
}

export interface ReplayRunnerOptions {
  readonly repository: PersistenceRepository;
  readonly configVersion?: number;
  readonly from: number;
  readonly to: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRank(event: Extract<ReplayEvent, { kind: "snapshot" }>): RankToken {
  const payload = asRecord(event.payload);
  if (payload === null || payload.tokenKey !== event.tokenKey || payload.address !== event.tokenKey) {
    throw new Error(`Invalid stored Rank payload at ingest_seq ${event.ingestSeq}`);
  }
  const interval = event.source === "rank_1m" ? "1m" : "5m";
  if (payload.interval !== interval) {
    throw new Error(`Stored Rank interval mismatch at ingest_seq ${event.ingestSeq}`);
  }
  if (event.eventType === "exit") {
    return { ...payload, rank: 101 } as unknown as RankToken;
  }
  if (typeof payload.rank !== "number" || !Number.isSafeInteger(payload.rank)) {
    throw new Error(`Invalid stored Rank value at ingest_seq ${event.ingestSeq}`);
  }
  return payload as unknown as RankToken;
}

function parseTrenches(event: Extract<ReplayEvent, { kind: "snapshot" }>): TrenchesToken | null {
  if (event.eventType === "exit") return null;
  const payload = asRecord(event.payload);
  if (
    payload === null ||
    payload.tokenKey !== event.tokenKey ||
    payload.address !== event.tokenKey ||
    (payload.stage !== "new_creation" &&
      payload.stage !== "near_completion" &&
      payload.stage !== "completed")
  ) {
    throw new Error(`Invalid stored Trenches payload at ingest_seq ${event.ingestSeq}`);
  }
  return payload as unknown as TrenchesToken;
}

function parseSecurity(event: Extract<ReplayEvent, { kind: "security" }>): SecuritySnapshot | null {
  if (event.status !== "passed") return null;
  const payload = asRecord(event.payload);
  if (
    payload === null ||
    payload.tokenKey !== event.tokenKey ||
    payload.address !== event.tokenKey ||
    typeof payload.isHoneypot !== "boolean" ||
    typeof payload.isOpenSource !== "boolean" ||
    typeof payload.buyTax !== "number" ||
    typeof payload.sellTax !== "number" ||
    typeof payload.top10HolderRate !== "number" ||
    !Array.isArray(payload.conflicts)
  ) {
    throw new Error(`Invalid stored Security payload at ingest_seq ${event.ingestSeq}`);
  }
  return payload as unknown as SecuritySnapshot;
}

function appendObservation<T>(history: Observation<T>[], observation: Observation<T>): void {
  history.push(observation);
  const cutoff = observation.capturedAt - HISTORY_MS;
  const retained = history.filter((item) => item.capturedAt >= cutoff).slice(-HISTORY_LIMIT);
  history.splice(0, history.length, ...retained);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export class ReplayRunner {
  public constructor(private readonly options: ReplayRunnerOptions) {}

  public run(): ReplayReport {
    const storedConfig = this.options.repository.getConfigVersion(this.options.configVersion);
    if (storedConfig === null) throw new Error("Requested config_version does not exist");
    const config = parseAppConfig(storedConfig.config);
    const replayFrom = Math.max(
      0,
      this.options.from - Math.max(HISTORY_MS, config.noise.creator_cooldown),
    );
    const events = this.options.repository.listReplayEvents(replayFrom, this.options.to);
    const histories = new Map<string, TokenHistory>();
    const current: ReplayCurrentState = {
      trenches: new Map(),
      rank1m: new Map(),
      rank5m: new Map(),
    };
    const states = new Map<string, TokenState>();
    const security = new Map<string, { capturedAt: number; value: SecuritySnapshot }>();
    const sourceSuccessAt = new Map<"trenches" | "rank_1m" | "rank_5m", number>();
    const recentSignals: RecentSignal[] = [];
    const signals: ReplaySignal[] = [];
    const decisions: ReplayDecision[] = [];
    const decisionSignatures = new Map<string, string>();
    const upstreamVersions = new Set<string>();
    const adapterVersions = new Set<string>();
    const samplingLevels = new Set<string>();
    let confirmations = 0;

    for (let index = 0; index < events.length; ) {
      const ingestSeq = events[index]?.ingestSeq ?? 0;
      const batch: ReplayEvent[] = [];
      while (index < events.length && events[index]?.ingestSeq === ingestSeq) {
        const event = events[index];
        if (event !== undefined) batch.push(event);
        index += 1;
      }
      const affected = new Set<string>();
      let now = 0;
      for (const event of batch) {
        if (!BSC_ADDRESS.test(event.tokenKey)) {
          throw new Error(`Invalid stored token key at ingest_seq ${event.ingestSeq}`);
        }
        now = Math.max(now, event.capturedAt);
        affected.add(event.tokenKey);
        adapterVersions.add(event.adapterVersion);
        if (event.kind === "security") {
          const value = parseSecurity(event);
          if (value === null) security.delete(event.tokenKey);
          else security.set(event.tokenKey, { capturedAt: event.capturedAt, value });
          continue;
        }
        upstreamVersions.add(event.upstreamFilterVersion);
        samplingLevels.add(event.samplingLevel);
        sourceSuccessAt.set(event.source, event.capturedAt);
        const history = histories.get(event.tokenKey) ?? { trenches: [], rank1m: [], rank5m: [] };
        if (event.source === "trenches") {
          const value = parseTrenches(event);
          appendObservation(history.trenches, {
            capturedAt: event.capturedAt,
            value,
          });
          if (value === null) current.trenches.delete(event.tokenKey);
          else current.trenches.set(event.tokenKey, value);
        } else {
          const value = parseRank(event);
          appendObservation(event.source === "rank_1m" ? history.rank1m : history.rank5m, {
            capturedAt: event.capturedAt,
            value,
          });
          const sourceCurrent = event.source === "rank_1m" ? current.rank1m : current.rank5m;
          if (event.eventType === "exit") sourceCurrent.delete(event.tokenKey);
          else sourceCurrent.set(event.tokenKey, value);
        }
        histories.set(event.tokenKey, history);
        if (!states.has(event.tokenKey)) {
          const value = asRecord(event.payload);
          states.set(event.tokenKey, {
            state: "observing",
            discovery: {
              discoveredAt: event.capturedAt,
              ...(typeof value?.price === "number" ? { price: value.price } : {}),
              ...(typeof value?.marketCap === "number" ? { marketCap: value.marketCap } : {}),
            },
          });
        }
      }

      for (const tokenKey of [...affected].sort()) {
        const state = states.get(tokenKey);
        const history = histories.get(tokenKey);
        if (state === undefined || history === undefined) continue;
        const cachedSecurity = security.get(tokenKey);
        const result = evaluateDetector({
          version: DETECTOR_VERSION,
          tokenKey,
          now,
          configVersion: storedConfig.version,
          config,
          state: state.state,
          market: this.marketAt(tokenKey, history, current, sourceSuccessAt, now, config),
          ...(cachedSecurity === undefined ? {} : { security: cachedSecurity }),
          discovery: state.discovery,
          ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
          recentSignals,
        });
        const signature = `${result.action}:${result.nextState}:${result.reason ?? ""}`;
        if (
          now >= this.options.from &&
          result.action !== "observe" &&
          result.action !== "no_change" &&
          decisionSignatures.get(tokenKey) !== signature
        ) {
          decisions.push({
            ingestSeq,
            capturedAt: now,
            tokenKey,
            action: result.action,
            reason: result.reason ?? null,
          });
          decisionSignatures.set(tokenKey, signature);
        }
        state.state = result.nextState;
        if (result.evidence !== undefined) state.candidate = result.evidence.reference;
        if (result.action === "qualified" && result.evidence !== undefined) {
          const replaySignal: ReplaySignal = {
            tokenKey,
            qualifiedAt: now,
            discoveredAt: state.discovery.discoveredAt,
            lifecycle: result.evidence.lifecycle,
            trigger: result.evidence.trigger,
            priority: result.evidence.priority,
            moveClass: result.moveClass ?? "unknown",
          };
          if (now >= this.options.from) signals.push(replaySignal);
          recentSignals.push({
            tokenKey,
            sentAt: now,
            priority: result.evidence.priority,
            ...(result.evidence.creatorAddress === undefined
              ? {}
              : { creatorAddress: result.evidence.creatorAddress }),
          });
          state.state = "sent";
        } else if (result.action === "confirmed") {
          if (now >= this.options.from) confirmations += 1;
          state.state = "confirmed";
        }
      }
    }

    const actualRows = this.options.repository.listStatisticsSignals(
      this.options.from,
      this.options.to,
      storedConfig.version,
    );
    if (upstreamVersions.size > 1 || adapterVersions.size > 1) {
      throw new Error("Replay range contains incompatible upstream or adapter versions");
    }
    const actualSummary = this.options.repository.summarizeSignals(
      this.options.from,
      this.options.to,
      storedConfig.version,
    );
    const evaluationAt = this.options.to + HOUR_MS;
    const replayQuality = aggregateStatistics(
      this.replayRows(actualRows, signals, storedConfig.version),
      evaluationAt,
    );
    const actualQuality = aggregateStatistics(
      actualRows,
      evaluationAt,
    );
    const researchSamples = this.options.repository.listResearchSamples(
      this.options.from,
      this.options.to,
    );
    const researchRows: StatisticsSignalRow[] = [];
    for (const sample of researchSamples) {
      const result = evaluateResearchFeature(sample.feature, config, storedConfig.version);
      if (result.action !== "qualified" || result.evidence === undefined) continue;
      researchRows.push({
        signalId: -sample.id,
        configVersion: storedConfig.version,
        tokenKey: sample.tokenKey,
        lifecycle: result.evidence.lifecycle,
        state: "sent",
        decision: result,
        qualifiedAt: sample.sampledAt,
        securityCompletedAt: sample.sampledAt,
        sentAt: sample.sampledAt,
        confirmedAt: null,
        outcomes: sample.outcomes,
      });
    }
    const researchQuality = aggregateStatistics(
      researchRows,
      evaluationAt,
    );
    const actionCounts = this.count(decisions.map((item) => item.action));
    const reasonCounts = this.count(
      decisions.map((item) => item.reason).filter((value): value is string => value !== null),
    );
    return {
      configVersion: storedConfig.version,
      from: this.options.from,
      to: this.options.to,
      eventCount: events.filter((event) => event.capturedAt >= this.options.from).length,
      candidateCount: new Set(decisions.map((item) => item.tokenKey)).size,
      signalCount: signals.length,
      confirmationCount: confirmations,
      actionCounts,
      reasonCounts,
      actualCandidateCount: actualSummary.candidates,
      actualStateCounts: actualSummary.stateCounts,
      actualReasonCounts: actualSummary.reasonCounts,
      upstreamFilterVersions: [...upstreamVersions].sort(),
      adapterVersions: [...adapterVersions].sort(),
      samplingLevels: [...samplingLevels].sort(),
      signals,
      decisions,
      replaySelectedQuality: {
        ...qualitySummary(replayQuality),
        medianLatencyMs: median(signals.map((signal) => signal.qualifiedAt - signal.discoveredAt)),
      },
      actualQuality: qualitySummary(actualQuality),
      researchSampleCount: researchSamples.length,
      researchSelectedCount: researchRows.length,
      researchSelectedQuality: qualitySummary(researchQuality),
      scopeLimitations: [
        "仅覆盖已保存的 GMGN 上游过滤后候选，不能评估被上游过滤掉的代币。",
        "普通榜单 update 历史精度最多为 5 秒，高频候选保留全部变化。",
        "历史快照没有记录空响应心跳；回放可识别离榜事件，但不能还原离榜后的连续成功缺席次数。",
        "回放不调用 GMGN 或 Telegram；质量对比只使用数据库中已有结果。",
        "研究质量仅基于 Security 已通过预热候选，每分钟最多 5 个，不包含完整跨 token 限频语义。",
      ],
    };
  }

  private marketAt(
    tokenKey: string,
    history: TokenHistory,
    current: ReplayCurrentState,
    sourceSuccessAt: ReadonlyMap<"trenches" | "rank_1m" | "rank_5m", number>,
    now: number,
    config: AppConfig,
  ): DetectorMarket {
    const fresh = (source: "trenches" | "rank_1m" | "rank_5m") => {
      const capturedAt = sourceSuccessAt.get(source);
      return capturedAt !== undefined && now - capturedAt <= config.gmgn.source_max_age_for_trigger;
    };
    const currentTrench = current.trenches.get(tokenKey);
    const currentRank1 = current.rank1m.get(tokenKey);
    const currentRank5 = current.rank5m.get(tokenKey);
    const currentTrenchAt = sourceSuccessAt.get("trenches");
    const currentRank1At = sourceSuccessAt.get("rank_1m");
    const currentRank5At = sourceSuccessAt.get("rank_5m");
    return {
      trenches: history.trenches,
      rank1m: history.rank1m,
      rank5m: history.rank5m,
      current: {
        ...(currentTrench === undefined ? {} : { trench: currentTrench }),
        ...(currentRank1 === undefined ? {} : { rank1m: currentRank1 }),
        ...(currentRank5 === undefined ? {} : { rank5m: currentRank5 }),
      },
      currentCapturedAt: {
        ...(currentTrenchAt === undefined ? {} : { trenches: currentTrenchAt }),
        ...(currentRank1At === undefined ? {} : { rank_1m: currentRank1At }),
        ...(currentRank5At === undefined ? {} : { rank_5m: currentRank5At }),
      },
      sourceFresh: {
        trenches: fresh("trenches"),
        rank_1m: fresh("rank_1m"),
        rank_5m: fresh("rank_5m"),
      },
      rank1mMissingSuccesses: history.rank1m.at(-1)?.value?.rank === 101 ? 1 : 0,
    };
  }

  private replayRows(
    rows: readonly StatisticsSignalRow[],
    signals: readonly ReplaySignal[],
    configVersion: number,
  ): readonly StatisticsSignalRow[] {
    const actual = new Map(rows.map((row) => [row.tokenKey, row]));
    return signals.map((signal, index): StatisticsSignalRow => {
      const row = actual.get(signal.tokenKey);
      return {
        signalId: row?.signalId ?? -(index + 1),
        configVersion,
        tokenKey: signal.tokenKey,
        lifecycle: signal.lifecycle,
        state: row?.state ?? "sent",
        decision: { trigger: signal.trigger },
        qualifiedAt: signal.qualifiedAt,
        securityCompletedAt: row?.securityCompletedAt ?? null,
        sentAt: signal.qualifiedAt,
        confirmedAt: row?.confirmedAt ?? null,
        outcomes: row?.outcomes ?? [],
      };
    });
  }

  private count(values: readonly string[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
}
