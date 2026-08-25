import type { AppConfig } from "../config/index.js";
import type {
  NoiseSelection,
  QualifiedCandidate,
  RecentSignal,
} from "./types.js";

const BSC_ADDRESS = /^0x[0-9a-f]{40}$/;

export function selectWithinNoiseLimits(
  candidates: readonly QualifiedCandidate[],
  recentSignals: readonly RecentSignal[],
  now: number,
  config: AppConfig["noise"],
): NoiseSelection {
  if (!Number.isSafeInteger(now)) {
    throw new RangeError("Noise-control time must be a safe integer");
  }
  for (const candidate of candidates) {
    if (!BSC_ADDRESS.test(candidate.tokenKey)) {
      throw new Error("Noise-control candidate token must be a normalized BSC address");
    }
    if (!Number.isSafeInteger(candidate.triggeredAt) || candidate.triggeredAt > now) {
      throw new RangeError("Noise-control trigger time must not be in the future");
    }
  }
  const minuteCutoff = now - 60_000;
  const creatorCutoff = now - config.creator_cooldown;
  const accepted: QualifiedCandidate[] = [];
  const suppressed: Array<QualifiedCandidate & { reason: string }> = [];
  const sorted = [...candidates].sort(
    (left, right) =>
      Number(right.priority === "high") - Number(left.priority === "high") ||
      left.triggeredAt - right.triggeredAt ||
      left.tokenKey.localeCompare(right.tokenKey),
  );
  const usedTokens = new Set(recentSignals.map((signal) => signal.tokenKey));
  let total = recentSignals.filter((signal) => signal.sentAt >= minuteCutoff).length;
  let normal = recentSignals.filter(
    (signal) => signal.sentAt >= minuteCutoff && signal.priority === "normal",
  ).length;
  const creatorLastSent = new Map<string, number>();
  for (const signal of recentSignals) {
    if (
      signal.creatorAddress !== undefined &&
      BSC_ADDRESS.test(signal.creatorAddress) &&
      signal.sentAt > creatorCutoff
    ) {
      creatorLastSent.set(
        signal.creatorAddress,
        Math.max(creatorLastSent.get(signal.creatorAddress) ?? 0, signal.sentAt),
      );
    }
  }

  for (const candidate of sorted) {
    let reason: string | undefined;
    if (usedTokens.has(candidate.tokenKey)) {
      reason = "token_lifecycle_duplicate";
    } else if (
      candidate.creatorAddress !== undefined &&
      BSC_ADDRESS.test(candidate.creatorAddress) &&
      (creatorLastSent.get(candidate.creatorAddress) ?? 0) > creatorCutoff
    ) {
      reason = "creator_cooldown";
    } else if (total >= config.max_initial_signals_per_minute) {
      reason = "global_signal_limit";
    } else if (
      candidate.priority === "normal" &&
      normal >= config.max_normal_signals_per_minute
    ) {
      reason = "normal_signal_limit";
    }

    if (reason !== undefined) {
      suppressed.push({ ...candidate, reason });
      continue;
    }
    accepted.push(candidate);
    usedTokens.add(candidate.tokenKey);
    total += 1;
    if (candidate.priority === "normal") {
      normal += 1;
    }
    if (candidate.creatorAddress !== undefined && BSC_ADDRESS.test(candidate.creatorAddress)) {
      creatorLastSent.set(candidate.creatorAddress, now);
    }
  }
  return { accepted, suppressed };
}
