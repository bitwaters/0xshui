import {
  adaptRank,
  adaptTrenches,
  type GmgnHttpClient,
  type TrenchesSnapshot,
} from "../gmgn/index.js";
import type { RealtimeSource, SourcePoller } from "./scheduler.js";
import type { SnapshotCoordinator } from "./snapshot-store.js";

export interface MarketPollerOptions {
  readonly client: GmgnHttpClient;
  readonly coordinator: SnapshotCoordinator;
  readonly rankLimit: number;
  readonly onFailure?: (source: RealtimeSource, error: unknown) => void;
  readonly onOverlap?: (source: RealtimeSource) => void;
  readonly onSuccess?: (source: RealtimeSource, capturedAt: number) => void;
}

export function createMarketPollers(
  options: MarketPollerOptions,
): Readonly<Record<RealtimeSource, SourcePoller>> {
  const trenches: SourcePoller = {
    poll: async () => {
      const raw = await options.client.fetchTrenches();
      return { value: adaptTrenches(raw.data), sourceCapturedAt: raw.receivedAt };
    },
    onSuccess: (_source, result) => {
      options.coordinator.commitTrenches(
        result.value as TrenchesSnapshot,
        result.sourceCapturedAt,
      );
      options.onSuccess?.("trenches", result.sourceCapturedAt);
    },
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.onOverlap === undefined ? {} : { onOverlap: options.onOverlap }),
  };
  const rankPoller = (
    source: "rank_1m" | "rank_5m",
    interval: "1m" | "5m",
  ): SourcePoller => ({
    poll: async () => {
      const raw = await options.client.fetchRank(interval, options.rankLimit);
      return { value: adaptRank(raw.data, interval), sourceCapturedAt: raw.receivedAt };
    },
    onSuccess: (_source, result) => {
      options.coordinator.commitRank(
        source,
        result.value as ReturnType<typeof adaptRank>,
        result.sourceCapturedAt,
      );
      options.onSuccess?.(source, result.sourceCapturedAt);
    },
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.onOverlap === undefined ? {} : { onOverlap: options.onOverlap }),
  });
  return {
    trenches,
    rank_1m: rankPoller("rank_1m", "1m"),
    rank_5m: rankPoller("rank_5m", "5m"),
  };
}
