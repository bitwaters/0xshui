import { adaptRank } from "./adapters.js";
import type { GmgnHttpClient } from "./client.js";

export interface GmgnSelfCheckResult {
  readonly ok: boolean;
  readonly formalDeliveryAllowed: boolean;
  readonly clockDriftMs: number | null;
  readonly reason?: "auth_or_schema" | "clock_drift";
}

export async function runGmgnSelfCheck(
  client: GmgnHttpClient,
  now = Date.now,
  maximumClockDriftMs = 30_000,
): Promise<GmgnSelfCheckResult> {
  try {
    const response = await client.fetchRank("1m", 1);
    const tokens = adaptRank(response.data, "1m");
    if (tokens.length === 0) {
      throw new Error("GMGN self-check Rank sample is empty");
    }
    const clockDriftMs =
      response.serverDateMs === null ? null : Math.abs(now() - response.serverDateMs);
    if (clockDriftMs !== null && clockDriftMs > maximumClockDriftMs) {
      return {
        ok: false,
        formalDeliveryAllowed: false,
        clockDriftMs,
        reason: "clock_drift",
      };
    }
    return { ok: true, formalDeliveryAllowed: true, clockDriftMs };
  } catch {
    return {
      ok: false,
      formalDeliveryAllowed: false,
      clockDriftMs: null,
      reason: "auth_or_schema",
    };
  }
}
