import type { AppConfig } from "../config/index.js";
import type { RiskFields, SecuritySnapshot } from "../gmgn/index.js";
import type { SafetyResult } from "./types.js";

export interface SafetyInput {
  readonly lifecycle: "curve" | "graduated";
  readonly security: SecuritySnapshot;
  readonly sources: readonly RiskFields[];
  readonly curveSource?: RiskFields;
  readonly sourceSecurity?: readonly {
    readonly isHoneypot?: boolean;
    readonly isOpenSource?: boolean;
    readonly isOwnerRenounced?: boolean;
    readonly buyTax?: number;
    readonly sellTax?: number;
    readonly top10HolderRate?: number;
    readonly lockPercent?: number;
    readonly burnStatus?: string;
  }[];
  readonly hasSafeTrenches: boolean;
  readonly config: AppConfig["risk_filters"];
}

function maximum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.max(...present);
}

function minimum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

function reject(reason: string): SafetyResult {
  return { status: "reject", reason };
}

function wait(reason: string): SafetyResult {
  return { status: "wait", reason };
}

export function evaluateSafety(input: SafetyInput): SafetyResult {
  const securitySources = input.sourceSecurity ?? [];
  const riskSources =
    input.curveSource === undefined ? input.sources : [...input.sources, input.curveSource];
  const booleans = {
    honeypot: [input.security.isHoneypot, ...securitySources.map((item) => item.isHoneypot)],
    openSource: [input.security.isOpenSource, ...securitySources.map((item) => item.isOpenSource)],
    ownerRenounced: [
      input.security.isOwnerRenounced,
      ...securitySources.map((item) => item.isOwnerRenounced),
    ],
  };
  if (booleans.honeypot.some((value) => value === true)) {
    return reject("honeypot");
  }
  if (booleans.openSource.some((value) => value === false)) {
    return reject("source_not_open");
  }
  if (input.security.isBlacklist === true) {
    return reject("blacklist_enabled");
  }

  const buyTax = maximum([input.security.buyTax, ...securitySources.map((item) => item.buyTax)]);
  const sellTax = maximum([
    input.security.sellTax,
    ...securitySources.map((item) => item.sellTax),
  ]);
  const top10 = maximum([
    input.security.top10HolderRate,
    ...riskSources.map((item) => item.top10HolderRate),
    ...securitySources.map((item) => item.top10HolderRate),
  ]);
  if (buyTax === undefined || sellTax === undefined || top10 === undefined) {
    return wait("universal_security_missing");
  }
  if (buyTax > input.config.max_buy_tax) {
    return reject("buy_tax");
  }
  if (sellTax > input.config.max_sell_tax) {
    return reject("sell_tax");
  }
  if (top10 > input.config.max_top10) {
    return reject("top10_concentration");
  }
  if (riskSources.some((source) => source.isWashTrading === true)) {
    return reject("wash_trading");
  }

  const ratioRules: readonly [keyof RiskFields, number, string][] = [
    ["rugRatio", input.config.max_rug, "rug_ratio"],
    ["bundlerRate", input.config.max_bundler, "bundler_rate"],
    ["insiderRate", input.config.max_insider, "insider_rate"],
    ["ratTraderRate", input.config.max_rat_trader, "rat_trader_rate"],
    ["entrapmentRatio", input.config.max_entrapment, "entrapment_ratio"],
    ["devTeamHoldRate", input.config.max_dev_hold, "dev_hold"],
    ["creatorBalanceRate", input.config.max_creator_hold, "creator_hold"],
  ];
  for (const [field, threshold, reason] of ratioRules) {
    const value = maximum(riskSources.map((source) => source[field] as number | undefined));
    if (value !== undefined && value > threshold) {
      return reject(reason);
    }
  }

  if (input.lifecycle === "curve") {
    if (!input.hasSafeTrenches) {
      return wait("safe_trenches_missing");
    }
    const required: readonly [keyof RiskFields, string][] = [
      ["bundlerRate", "bundler_missing"],
      ["insiderRate", "insider_missing"],
      ["devTeamHoldRate", "dev_hold_missing"],
      ["creatorBalanceRate", "creator_hold_missing"],
    ];
    for (const [field, reason] of required) {
      if (input.curveSource?.[field] === undefined) {
        return wait(reason);
      }
    }
    return { status: "pass" };
  }

  if (booleans.ownerRenounced.every((value) => value === undefined)) {
    return wait("owner_status_missing");
  }
  if (booleans.ownerRenounced.some((value) => value === false)) {
    return reject("owner_not_renounced");
  }
  const burnStatuses = [
    input.security.burnStatus,
    ...securitySources.map((item) => item.burnStatus),
  ];
  const presentBurnStatuses = burnStatuses.filter(
    (value): value is string => value !== undefined,
  );
  const burned =
    presentBurnStatuses.length > 0 &&
    presentBurnStatuses.every((value) => value.trim().toLowerCase() === "burn");
  const lockPercent = minimum([
    input.security.lockPercent,
    ...securitySources.map((item) => item.lockPercent),
  ]);
  if (!burned && lockPercent === undefined) {
    return wait("lp_evidence_missing");
  }
  if (!burned && (lockPercent ?? 0) < 0.5) {
    return reject("lp_not_secured");
  }
  return { status: "pass" };
}
