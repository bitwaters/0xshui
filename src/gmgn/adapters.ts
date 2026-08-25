import { z, ZodError } from "zod";

import { GmgnContractError } from "./errors.js";
import type {
  Candle,
  PoolSnapshot,
  RankInterval,
  RankToken,
  RiskFields,
  SecuritySnapshot,
  TrenchesSnapshot,
  TrenchesStage,
  TrenchesToken,
} from "./models.js";
import {
  explicitBoolean,
  finiteNumber,
  integer,
  nonNegativeNumber,
  normalizeBscAddress,
  objectRecord,
  optionalAddress,
  optionalText,
  optionalValue,
  positiveNumber,
  ratio,
  timestampMs,
} from "./normalize.js";

const recordSchema = z.object({}).loose();
const rankPayloadSchema = z.object({ rank: z.array(z.unknown()).max(100) }).loose();
const klinePayloadSchema = z.object({ list: z.array(z.unknown()) }).loose();

function contractParse<T>(parser: () => T, label: string): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof GmgnContractError) {
      throw error;
    }
    if (error instanceof ZodError) {
      throw new GmgnContractError(`${label} does not match the expected GMGN contract`);
    }
    throw error;
  }
}

function presentValues(record: Record<string, unknown>, aliases: readonly string[]): unknown[] {
  return aliases
    .map((alias) => record[alias])
    .filter((value) => value !== undefined && value !== null && value !== "");
}

function optionalRatioAliases(
  record: Record<string, unknown>,
  aliases: readonly string[],
  field: string,
): number | undefined {
  const values = presentValues(record, aliases).map((value) => ratio(value, field));
  return values.length === 0 ? undefined : Math.max(...values);
}

function optionalNumberAliases(
  record: Record<string, unknown>,
  aliases: readonly string[],
  field: string,
): number | undefined {
  const value = presentValues(record, aliases)[0];
  return value === undefined ? undefined : nonNegativeNumber(value, field);
}

function booleanAliases(
  record: Record<string, unknown>,
  aliases: readonly string[],
  field: string,
  dangerousValue: boolean,
  required: boolean,
  conflicts?: string[],
): boolean | undefined {
  const values = presentValues(record, aliases).map((value) => explicitBoolean(value, field));
  if (values.length === 0) {
    if (required) {
      throw new GmgnContractError(`${field} is required`);
    }
    return undefined;
  }
  if (new Set(values).size > 1) {
    conflicts?.push(field);
    return dangerousValue;
  }
  return values[0];
}

function riskFields(record: Record<string, unknown>): RiskFields {
  const rugRatio = optionalRatioAliases(record, ["rug_ratio"], "rug_ratio");
  const bundlerRate = optionalRatioAliases(
    record,
    ["bundler_rate", "bundler_trader_amount_rate"],
    "bundler_rate",
  );
  const insiderRate = optionalRatioAliases(
    record,
    ["suspected_insider_hold_rate", "insider_ratio"],
    "insider_rate",
  );
  const ratTraderRate = optionalRatioAliases(
    record,
    ["rat_trader_amount_rate"],
    "rat_trader_rate",
  );
  const entrapmentRatio = optionalRatioAliases(
    record,
    ["entrapment_ratio"],
    "entrapment_ratio",
  );
  const devTeamHoldRate = optionalRatioAliases(
    record,
    ["dev_team_hold_rate"],
    "dev_team_hold_rate",
  );
  const creatorBalanceRate = optionalRatioAliases(
    record,
    ["creator_balance_rate"],
    "creator_balance_rate",
  );
  const top10HolderRate = optionalRatioAliases(
    record,
    ["top_10_holder_rate", "top10_holder_rate", "top_holder_rate"],
    "top10_holder_rate",
  );
  const isWashTrading = booleanAliases(
    record,
    ["is_wash_trading"],
    "is_wash_trading",
    true,
    false,
  );
  return {
    ...(rugRatio === undefined ? {} : { rugRatio }),
    ...(bundlerRate === undefined ? {} : { bundlerRate }),
    ...(insiderRate === undefined ? {} : { insiderRate }),
    ...(ratTraderRate === undefined ? {} : { ratTraderRate }),
    ...(entrapmentRatio === undefined ? {} : { entrapmentRatio }),
    ...(devTeamHoldRate === undefined ? {} : { devTeamHoldRate }),
    ...(creatorBalanceRate === undefined ? {} : { creatorBalanceRate }),
    ...(top10HolderRate === undefined ? {} : { top10HolderRate }),
    ...(isWashTrading === undefined ? {} : { isWashTrading }),
  };
}

export function adaptRank(payload: unknown, interval: RankInterval): readonly RankToken[] {
  return contractParse(() => {
    const parsed = rankPayloadSchema.parse(payload);
    return parsed.rank.map((raw, index) => {
      const item = recordSchema.parse(raw);
      const address = normalizeBscAddress(item.address, `rank[${index}].address`);
      const rank = integer(item.rank, `rank[${index}].rank`, 1);
      if (rank > 100) {
        throw new GmgnContractError(`rank[${index}].rank must not exceed 100`);
      }
      const lockPercent = optionalValue(item.lock_percent, (value) =>
        ratio(value, `rank[${index}].lock_percent`),
      );
      const buyTax = optionalValue(item.buy_tax, (value) =>
        ratio(value, `rank[${index}].buy_tax`),
      );
      const sellTax = optionalValue(item.sell_tax, (value) =>
        ratio(value, `rank[${index}].sell_tax`),
      );
      const isHoneypot = booleanAliases(
        item,
        ["is_honeypot", "honeypot"],
        `rank[${index}].is_honeypot`,
        true,
        false,
      );
      const isOpenSource = booleanAliases(
        item,
        ["is_open_source", "open_source"],
        `rank[${index}].is_open_source`,
        false,
        false,
      );
      const isOwnerRenounced = booleanAliases(
        item,
        ["is_renounced", "renounced", "owner_renounced"],
        `rank[${index}].is_owner_renounced`,
        false,
        false,
      );
      const creationTimestampMs = optionalValue(
        item.creation_timestamp ?? item.created_timestamp,
        (value) => timestampMs(value, `rank[${index}].creation_timestamp`),
      );
      const name = optionalText(item.name);
      const symbol = optionalText(item.symbol, 64);
      const creatorAddress = optionalAddress(item.creator, `rank[${index}].creator`);
      const launchpadPlatform = optionalText(item.launchpad_platform, 64);
      const smartDegenCount = optionalValue(item.smart_degen_count, (value) =>
        integer(value, `rank[${index}].smart_degen_count`),
      );
      const burnStatus = optionalText(item.burn_status, 32);
      return {
        ...riskFields(item),
        tokenKey: address,
        address,
        interval,
        rank,
        price: positiveNumber(item.price, `rank[${index}].price`),
        marketCap: nonNegativeNumber(item.market_cap, `rank[${index}].market_cap`),
        liquidity: nonNegativeNumber(item.liquidity, `rank[${index}].liquidity`),
        swaps: integer(item.swaps, `rank[${index}].swaps`),
        buys: integer(item.buys, `rank[${index}].buys`),
        sells: integer(item.sells, `rank[${index}].sells`),
        holderCount: integer(item.holder_count, `rank[${index}].holder_count`),
        ...(name === undefined ? {} : { name }),
        ...(symbol === undefined ? {} : { symbol }),
        ...(creatorAddress === undefined ? {} : { creatorAddress }),
        ...(launchpadPlatform === undefined ? {} : { launchpadPlatform }),
        ...(smartDegenCount === undefined ? {} : { smartDegenCount }),
        ...(lockPercent === undefined ? {} : { lockPercent }),
        ...(burnStatus === undefined ? {} : { burnStatus }),
        ...(buyTax === undefined ? {} : { buyTax }),
        ...(sellTax === undefined ? {} : { sellTax }),
        ...(isHoneypot === undefined ? {} : { isHoneypot }),
        ...(isOpenSource === undefined ? {} : { isOpenSource }),
        ...(isOwnerRenounced === undefined ? {} : { isOwnerRenounced }),
        ...(creationTimestampMs === undefined ? {} : { creationTimestampMs }),
      } satisfies RankToken;
    });
  }, "Rank response");
}

function adaptTrenchesItem(
  raw: unknown,
  stage: TrenchesStage,
  index: number,
): TrenchesToken {
  const item = recordSchema.parse(raw);
  const prefix = `${stage}[${index}]`;
  const address = normalizeBscAddress(item.address, `${prefix}.address`);
  const price = optionalValue(item.price, (value) => nonNegativeNumber(value, `${prefix}.price`));
  const holderCount = optionalValue(item.holder_count, (value) =>
    integer(value, `${prefix}.holder_count`),
  );
  const curveSwapsTotal = optionalValue(item.swaps_24h, (value) =>
    integer(value, `${prefix}.swaps_24h`),
  );
  const curveNetBuyTotal = optionalValue(item.net_buy_24h, (value) =>
    finiteNumber(value, `${prefix}.net_buy_24h`),
  );
  const bondingProgress = optionalValue(item.progress ?? item.launchpad_progress, (value) =>
    ratio(value, `${prefix}.progress`),
  );
  const marketCap = optionalNumberAliases(
    item,
    ["usd_market_cap", "market_cap"],
    `${prefix}.market_cap`,
  );
  const liquidity = optionalValue(item.liquidity, (value) =>
    nonNegativeNumber(value, `${prefix}.liquidity`),
  );
  const smartDegenCount = optionalValue(item.smart_degen_count, (value) =>
    integer(value, `${prefix}.smart_degen_count`),
  );
  const creationTimestampMs = optionalValue(
    item.created_timestamp ?? item.creation_timestamp,
    (value) => timestampMs(value, `${prefix}.creation_timestamp`),
  );
  const name = optionalText(item.name);
  const symbol = optionalText(item.symbol, 64);
  const creatorAddress = optionalAddress(item.creator, `${prefix}.creator`);
  const launchpadPlatform = optionalText(item.launchpad_platform, 64);
  const burnStatus = optionalText(item.burn_status, 32);
  return {
    ...riskFields(item),
    tokenKey: address,
    address,
    stage,
    ...(name === undefined ? {} : { name }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(creatorAddress === undefined ? {} : { creatorAddress }),
    ...(launchpadPlatform === undefined ? {} : { launchpadPlatform }),
    ...(price === undefined ? {} : { price }),
    ...(marketCap === undefined ? {} : { marketCap }),
    ...(liquidity === undefined ? {} : { liquidity }),
    ...(holderCount === undefined ? {} : { holderCount }),
    ...(curveSwapsTotal === undefined ? {} : { curveSwapsTotal }),
    ...(curveNetBuyTotal === undefined ? {} : { curveNetBuyTotal }),
    ...(bondingProgress === undefined ? {} : { bondingProgress }),
    ...(smartDegenCount === undefined ? {} : { smartDegenCount }),
    ...(burnStatus === undefined ? {} : { burnStatus }),
    ...(creationTimestampMs === undefined ? {} : { creationTimestampMs }),
  };
}

export function adaptTrenches(payload: unknown): TrenchesSnapshot {
  return contractParse(() => {
    const record = recordSchema.parse(payload);
    const near = record.near_completion;
    const pump = record.pump;
    if (near !== undefined && pump !== undefined) {
      throw new GmgnContractError("Trenches response contains both near_completion and pump");
    }
    const rawStages: Record<TrenchesStage, unknown> = {
      new_creation: record.new_creation,
      near_completion: near ?? pump,
      completed: record.completed,
    };
    const truncatedStages: TrenchesStage[] = [];
    const parseStage = (stage: TrenchesStage): readonly TrenchesToken[] => {
      const rawItems = z.array(z.unknown()).parse(rawStages[stage]);
      if (rawItems.length > 80) {
        truncatedStages.push(stage);
      }
      return rawItems.slice(0, 80).map((item, index) => adaptTrenchesItem(item, stage, index));
    };
    const stages: Record<TrenchesStage, readonly TrenchesToken[]> = {
      new_creation: parseStage("new_creation"),
      near_completion: parseStage("near_completion"),
      completed: parseStage("completed"),
    };
    return { stages, truncatedStages };
  }, "Trenches response");
}

export function adaptSecurity(payload: unknown): SecuritySnapshot {
  return contractParse(() => {
    const item = recordSchema.parse(payload);
    const address = normalizeBscAddress(item.address, "security.address");
    const conflicts: string[] = [];
    const isHoneypot = booleanAliases(
      item,
      ["is_honeypot", "honeypot"],
      "security.is_honeypot",
      true,
      true,
      conflicts,
    );
    const isOpenSource = booleanAliases(
      item,
      ["is_open_source", "open_source"],
      "security.is_open_source",
      false,
      true,
      conflicts,
    );
    const isOwnerRenounced = booleanAliases(
      item,
      ["owner_renounced", "is_renounced", "renounced"],
      "security.is_owner_renounced",
      false,
      false,
      conflicts,
    );
    const isBlacklist = booleanAliases(
      item,
      ["is_blacklist", "blacklist"],
      "security.is_blacklist",
      true,
      false,
      conflicts,
    );

    let lockPercent: number | undefined;
    if (item.lock_summary !== undefined && item.lock_summary !== null) {
      const summary = objectRecord(item.lock_summary, "security.lock_summary");
      if (summary.lock_detail !== undefined && summary.lock_detail !== null) {
        const details = z.array(z.unknown()).parse(summary.lock_detail);
        const percentages = details.map((detail, index) => {
          const row = recordSchema.parse(detail);
          return ratio(row.percent, `security.lock_detail[${index}].percent`);
        });
        if (percentages.length > 0) {
          lockPercent = Math.max(...percentages);
        }
      }
    }
    const burnStatus = optionalText(item.burn_status, 32);
    return {
      tokenKey: address,
      address,
      isHoneypot: isHoneypot as boolean,
      isOpenSource: isOpenSource as boolean,
      buyTax: ratio(item.buy_tax, "security.buy_tax"),
      sellTax: ratio(item.sell_tax, "security.sell_tax"),
      top10HolderRate: ratio(item.top_10_holder_rate, "security.top_10_holder_rate"),
      conflicts,
      ...(isOwnerRenounced === undefined ? {} : { isOwnerRenounced }),
      ...(isBlacklist === undefined ? {} : { isBlacklist }),
      ...(burnStatus === undefined ? {} : { burnStatus }),
      ...(lockPercent === undefined ? {} : { lockPercent }),
    };
  }, "Security response");
}

export function adaptKline(payload: unknown): readonly Candle[] {
  return contractParse(() => {
    const parsed = klinePayloadSchema.parse(payload);
    let previousTime = -1;
    return parsed.list.map((raw, index) => {
      const item = recordSchema.parse(raw);
      const timeMs = integer(item.time, `kline[${index}].time`, 1);
      if (timeMs < 1_000_000_000_000 || timeMs <= previousTime) {
        throw new GmgnContractError("Kline times must be unique ascending millisecond timestamps");
      }
      previousTime = timeMs;
      const open = positiveNumber(item.open, `kline[${index}].open`);
      const close = positiveNumber(item.close, `kline[${index}].close`);
      const high = positiveNumber(item.high, `kline[${index}].high`);
      const low = positiveNumber(item.low, `kline[${index}].low`);
      if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
        throw new GmgnContractError(`kline[${index}] has inconsistent OHLC values`);
      }
      return {
        timeMs,
        open,
        close,
        high,
        low,
        volumeUsd: nonNegativeNumber(item.volume, `kline[${index}].volume`),
        amountToken: nonNegativeNumber(item.amount, `kline[${index}].amount`),
      };
    });
  }, "Kline response");
}

export function adaptPool(payload: unknown): PoolSnapshot {
  return contractParse(() => {
    const item = recordSchema.parse(payload);
    const address = normalizeBscAddress(item.address ?? item.base_address, "pool.address");
    const baseAddress = normalizeBscAddress(item.base_address ?? item.address, "pool.base_address");
    if (address !== baseAddress) {
      throw new GmgnContractError("Pool token address fields conflict");
    }
    const price = optionalValue(item.price, (value) => positiveNumber(value, "pool.price"));
    const exchange = optionalText(item.exchange, 64);
    if (exchange === undefined) {
      throw new GmgnContractError("pool.exchange is required");
    }
    return {
      tokenKey: address,
      address,
      poolAddress: normalizeBscAddress(item.pool_address, "pool.pool_address"),
      quoteAddress: normalizeBscAddress(item.quote_address, "pool.quote_address"),
      exchange,
      liquidity: nonNegativeNumber(item.liquidity, "pool.liquidity"),
      baseReserve: nonNegativeNumber(item.base_reserve, "pool.base_reserve"),
      quoteReserve: nonNegativeNumber(item.quote_reserve, "pool.quote_reserve"),
      creationTimestampMs: timestampMs(item.creation_timestamp, "pool.creation_timestamp"),
      ...(price === undefined ? {} : { price }),
    };
  }, "Pool response");
}
