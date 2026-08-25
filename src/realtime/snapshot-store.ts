import type { PersistenceRepository, SamplingLevel, SnapshotEvent } from "../db/index.js";
import type { RankToken, TrenchesSnapshot, TrenchesToken } from "../gmgn/index.js";
import type { RealtimeSource } from "./scheduler.js";

export interface WindowEvent {
  readonly ingestSeq: number;
  readonly source: RealtimeSource | "security";
  readonly eventType: "enter" | "update" | "exit" | "security";
  readonly capturedAt: number;
  readonly data: unknown;
}

interface SourceState {
  readonly payload: Record<string, unknown>;
  readonly sourceCapturedAt: number;
}

export interface SnapshotCoordinatorOptions {
  readonly repository: PersistenceRepository;
  readonly windowStore: TokenWindowStore;
  readonly isHighPriority?: (tokenKey: string) => boolean;
  readonly ordinarySnapshotIntervalMs?: number;
  readonly onCommitted?: (
    source: RealtimeSource,
    ingestSeq: number,
    tokenKeys: readonly string[],
    capturedAt: number,
  ) => void;
  readonly now?: () => number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Snapshot payload contains a non-JSON value");
  }
  return serialized;
}

function flattenTrenches(snapshot: TrenchesSnapshot): readonly TrenchesToken[] {
  return [
    ...snapshot.stages.new_creation,
    ...snapshot.stages.near_completion,
    ...snapshot.stages.completed,
  ];
}

function rankPayload(token: RankToken): Record<string, unknown> {
  return { ...token };
}

function trenchesPayload(token: TrenchesToken): Record<string, unknown> {
  return { ...token };
}

export class TokenWindowStore {
  private readonly events = new Map<string, WindowEvent[]>();
  private readonly sourceSuccessAt = new Map<RealtimeSource, number>();
  private readonly currentBySource = new Map<RealtimeSource, Map<string, unknown>>();
  private readonly currentCapturedAt = new Map<RealtimeSource, number>();
  private readonly consecutiveMissingByRankSource = new Map<
    "rank_1m" | "rank_5m",
    Map<string, number>
  >();

  public constructor(
    private readonly retentionMs = 60_000,
    private readonly maximumEventsPerToken = 10,
    private readonly sourceFreshnessMs = 10_000,
  ) {}

  public add(tokenKey: string, event: WindowEvent, now = event.capturedAt): void {
    const existing = this.events.get(tokenKey) ?? [];
    existing.push(event);
    const cutoff = now - this.retentionMs;
    const retained = existing
      .filter((item) => item.capturedAt >= cutoff)
      .sort((left, right) => left.ingestSeq - right.ingestSeq)
      .slice(-this.maximumEventsPerToken);
    this.events.set(tokenKey, retained);
  }

  public markSourceSuccess(source: RealtimeSource, capturedAt: number): void {
    this.sourceSuccessAt.set(source, capturedAt);
  }

  public replaceCurrentSource(
    source: RealtimeSource,
    values: readonly { readonly tokenKey: string; readonly data: unknown }[],
    capturedAt: number,
  ): void {
    const next = new Map(values.map((value) => [value.tokenKey, value.data]));
    const previous = this.currentBySource.get(source);
    if (source === "rank_1m" || source === "rank_5m") {
      const missing = this.consecutiveMissingByRankSource.get(source) ?? new Map<string, number>();
      const tracked = new Set([...(previous?.keys() ?? []), ...missing.keys()]);
      for (const tokenKey of tracked) {
        if (next.has(tokenKey)) missing.delete(tokenKey);
        else missing.set(tokenKey, (missing.get(tokenKey) ?? 0) + 1);
      }
      this.consecutiveMissingByRankSource.set(source, missing);
    }
    this.currentBySource.set(source, next);
    this.currentCapturedAt.set(source, capturedAt);
  }

  public getCurrent<T>(tokenKey: string, source: RealtimeSource): T | undefined {
    return this.currentBySource.get(source)?.get(tokenKey) as T | undefined;
  }

  public getCurrentCapturedAt(source: RealtimeSource): number | undefined {
    return this.currentCapturedAt.get(source);
  }

  public getConsecutiveRankMisses(
    tokenKey: string,
    source: "rank_1m" | "rank_5m",
  ): number {
    return this.consecutiveMissingByRankSource.get(source)?.get(tokenKey) ?? 0;
  }

  public isSourceFresh(source: RealtimeSource, now: number): boolean {
    const lastSuccess = this.sourceSuccessAt.get(source);
    return lastSuccess !== undefined && now - lastSuccess <= this.sourceFreshnessMs;
  }

  public getEvents(tokenKey: string, now: number): readonly WindowEvent[] {
    const existing = this.events.get(tokenKey) ?? [];
    const cutoff = now - this.retentionMs;
    return existing.filter((event) => event.capturedAt >= cutoff);
  }

  public getFreshEvents(
    tokenKey: string,
    source: RealtimeSource,
    now: number,
  ): readonly WindowEvent[] {
    if (!this.isSourceFresh(source, now)) {
      return [];
    }
    return this.getEvents(tokenKey, now).filter(
      (event) => event.source === source && now - event.capturedAt <= this.sourceFreshnessMs,
    );
  }

  public static effectiveRank(rank: number | null): number {
    return rank ?? 101;
  }
}

export class SnapshotCoordinator {
  private readonly baselines = new Map<RealtimeSource, Map<string, SourceState>>();
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly ordinarySnapshotIntervalMs: number;

  public constructor(private readonly options: SnapshotCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.ordinarySnapshotIntervalMs = options.ordinarySnapshotIntervalMs ?? 5_000;
    if (!Number.isSafeInteger(this.ordinarySnapshotIntervalMs) || this.ordinarySnapshotIntervalMs <= 0) {
      throw new RangeError("Ordinary snapshot interval must be a positive integer");
    }
  }

  public commitRank(
    source: "rank_1m" | "rank_5m",
    tokens: readonly RankToken[],
    sourceCapturedAt: number,
  ): number | null {
    return this.commit(
      source,
      tokens.map((token) => ({ tokenKey: token.tokenKey, payload: rankPayload(token) })),
      sourceCapturedAt,
    );
  }

  public commitTrenches(snapshot: TrenchesSnapshot, sourceCapturedAt: number): number | null {
    return this.commit(
      "trenches",
      flattenTrenches(snapshot).map((token) => ({
        tokenKey: token.tokenKey,
        payload: trenchesPayload(token),
      })),
      sourceCapturedAt,
    );
  }

  public hasBaseline(source: RealtimeSource): boolean {
    return this.baselines.has(source);
  }

  private commit(
    source: RealtimeSource,
    values: readonly { readonly tokenKey: string; readonly payload: Record<string, unknown> }[],
    sourceCapturedAt: number,
  ): number | null {
    const capturedAt = this.now();
    const next = new Map<string, SourceState>();
    for (const { tokenKey, payload } of values) {
      if (next.has(tokenKey)) {
        throw new Error(`Duplicate token ${tokenKey} in ${source} response`);
      }
      next.set(tokenKey, { payload, sourceCapturedAt });
    }
    const previous = this.baselines.get(source);
    if (previous === undefined) {
      const baselineEvents = [...next.entries()].map(([tokenKey, state]) =>
        this.snapshotEvent(tokenKey, "enter", state.payload, capturedAt, sourceCapturedAt),
      );
      const baselineSeq = this.options.repository.appendSourceBatch(source, baselineEvents);
      this.recordPersisted(source, baselineEvents);
      this.baselines.set(source, next);
      this.options.windowStore.replaceCurrentSource(
        source,
        [...next.entries()].map(([tokenKey, state]) => ({ tokenKey, data: state.payload })),
        capturedAt,
      );
      this.options.windowStore.markSourceSuccess(source, capturedAt);
      if (baselineSeq !== null) {
        for (const event of baselineEvents) {
          this.options.windowStore.add(event.tokenKey, {
            ingestSeq: baselineSeq,
            source,
            eventType: event.eventType,
            capturedAt,
            data: event.payload,
          });
        }
      }
      return null;
    }

    const events: SnapshotEvent[] = [];
    for (const [tokenKey, state] of next) {
      const prior = previous.get(tokenKey);
      const eventType = prior === undefined ? "enter" : "update";
      if (prior !== undefined && stableJson(prior.payload) === stableJson(state.payload)) {
        continue;
      }
      events.push(
        this.snapshotEvent(tokenKey, eventType, state.payload, capturedAt, sourceCapturedAt),
      );
    }
    for (const [tokenKey, state] of previous) {
      if (next.has(tokenKey)) {
        continue;
      }
      const payload = source.startsWith("rank_")
        ? { ...state.payload, rank: null }
        : state.payload;
      events.push(this.snapshotEvent(tokenKey, "exit", payload, capturedAt, sourceCapturedAt));
    }

    const persistedEvents = events.filter((event) => this.shouldPersist(source, event));
    const ingestSeq = this.options.repository.appendSourceBatch(source, persistedEvents);
    this.recordPersisted(source, persistedEvents);
    this.baselines.set(source, next);
    this.options.windowStore.replaceCurrentSource(
      source,
      [...next.entries()].map(([tokenKey, state]) => ({ tokenKey, data: state.payload })),
      capturedAt,
    );
    this.options.windowStore.markSourceSuccess(source, capturedAt);
    if (ingestSeq === null) {
      return null;
    }
    for (const event of persistedEvents) {
      this.options.windowStore.add(event.tokenKey, {
        ingestSeq,
        source,
        eventType: event.eventType,
        capturedAt,
        data: event.payload,
      });
    }
    this.options.onCommitted?.(
      source,
      ingestSeq,
      persistedEvents.map((event) => event.tokenKey),
      capturedAt,
    );
    return ingestSeq;
  }

  private shouldPersist(source: RealtimeSource, event: SnapshotEvent): boolean {
    if (event.eventType !== "update" || event.samplingLevel === "high") {
      return true;
    }
    const last = this.lastPersistedAt.get(`${source}:${event.tokenKey}`);
    return last === undefined || event.capturedAt - last >= this.ordinarySnapshotIntervalMs;
  }

  private recordPersisted(source: RealtimeSource, events: readonly SnapshotEvent[]): void {
    for (const event of events) {
      const key = `${source}:${event.tokenKey}`;
      if (event.eventType === "exit") {
        this.lastPersistedAt.delete(key);
      } else {
        this.lastPersistedAt.set(key, event.capturedAt);
      }
    }
  }

  private snapshotEvent(
    tokenKey: string,
    eventType: "enter" | "update" | "exit",
    payload: Record<string, unknown>,
    capturedAt: number,
    sourceCapturedAt: number,
  ): SnapshotEvent {
    const samplingLevel: SamplingLevel = this.options.isHighPriority?.(tokenKey)
      ? "high"
      : "ordinary";
    return {
      tokenKey,
      eventType,
      capturedAt,
      sourceCapturedAt,
      samplingLevel,
      payload,
      upstreamFilterVersion: "gmgn-not-honeypot-v2",
      adapterVersion: "gmgn-adapter-v1",
    };
  }
}
