import type { AppConfig } from "../config/index.js";
import {
  DETECTOR_VERSION,
  evaluateDetector,
  type DetectorDecision,
  type DetectorInput,
  type DetectorMarket,
  type DiscoveryReference,
  type SecurityObservation,
} from "../detection/index.js";

export interface ResearchFeature {
  readonly version: typeof DETECTOR_VERSION;
  readonly tokenKey: string;
  readonly sampledAt: number;
  readonly market: DetectorMarket;
  readonly security: SecurityObservation;
  readonly discovery: DiscoveryReference;
}

export interface BuiltResearchSample {
  readonly lifecycle: "curve" | "graduated";
  readonly baselinePrice: number;
  readonly feature: ResearchFeature;
}

function latestValue<T>(values: readonly { readonly value: T | null }[]): T | undefined {
  return [...values].reverse().find((item) => item.value !== null)?.value ?? undefined;
}

export function buildResearchSample(input: DetectorInput): BuiltResearchSample | null {
  if (input.security === undefined) return null;
  const trench = latestValue(input.market.trenches);
  const rank1 = latestValue(input.market.rank1m);
  const lifecycle = trench !== undefined && trench.stage !== "completed" ? "curve" : "graduated";
  const baselinePrice =
    lifecycle === "curve" ? (trench?.price ?? rank1?.price) : (rank1?.price ?? trench?.price);
  if (baselinePrice === undefined || !Number.isFinite(baselinePrice) || baselinePrice <= 0) {
    return null;
  }
  return {
    lifecycle,
    baselinePrice,
    feature: {
      version: DETECTOR_VERSION,
      tokenKey: input.tokenKey,
      sampledAt: input.now,
      market: input.market,
      security: input.security,
      discovery: input.discovery,
    },
  };
}

export function evaluateResearchFeature(
  value: unknown,
  config: AppConfig,
  configVersion: number,
): DetectorDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid research feature payload");
  }
  const feature = value as Partial<ResearchFeature>;
  if (
    feature.version !== DETECTOR_VERSION ||
    typeof feature.tokenKey !== "string" ||
    typeof feature.sampledAt !== "number" ||
    !Number.isSafeInteger(feature.sampledAt) ||
    feature.market === undefined ||
    feature.security === undefined ||
    feature.discovery === undefined
  ) {
    throw new Error("Incomplete research feature payload");
  }
  return evaluateDetector({
    version: DETECTOR_VERSION,
    tokenKey: feature.tokenKey,
    now: feature.sampledAt,
    configVersion,
    config,
    state: "observing",
    market: feature.market,
    security: feature.security,
    discovery: feature.discovery,
    recentSignals: [],
  });
}
