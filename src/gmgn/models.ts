export type RankInterval = "1m" | "5m";
export type TrenchesStage = "new_creation" | "near_completion" | "completed";

export interface RiskFields {
  readonly rugRatio?: number;
  readonly bundlerRate?: number;
  readonly insiderRate?: number;
  readonly ratTraderRate?: number;
  readonly entrapmentRatio?: number;
  readonly devTeamHoldRate?: number;
  readonly creatorBalanceRate?: number;
  readonly top10HolderRate?: number;
  readonly isWashTrading?: boolean;
}

export interface RankToken extends RiskFields {
  readonly tokenKey: string;
  readonly address: string;
  readonly interval: RankInterval;
  readonly rank: number;
  readonly name?: string;
  readonly symbol?: string;
  readonly creatorAddress?: string;
  readonly launchpadPlatform?: string;
  readonly price: number;
  readonly marketCap: number;
  readonly liquidity: number;
  readonly swaps: number;
  readonly buys: number;
  readonly sells: number;
  readonly holderCount: number;
  readonly smartDegenCount?: number;
  readonly lockPercent?: number;
  readonly burnStatus?: string;
  readonly buyTax?: number;
  readonly sellTax?: number;
  readonly isHoneypot?: boolean;
  readonly isOpenSource?: boolean;
  readonly isOwnerRenounced?: boolean;
  readonly creationTimestampMs?: number;
}

export interface TrenchesToken extends RiskFields {
  readonly tokenKey: string;
  readonly address: string;
  readonly stage: TrenchesStage;
  readonly name?: string;
  readonly symbol?: string;
  readonly creatorAddress?: string;
  readonly launchpadPlatform?: string;
  readonly price?: number;
  readonly marketCap?: number;
  readonly liquidity?: number;
  readonly holderCount?: number;
  readonly curveSwapsTotal?: number;
  readonly curveNetBuyTotal?: number;
  readonly bondingProgress?: number;
  readonly smartDegenCount?: number;
  readonly burnStatus?: string;
  readonly creationTimestampMs?: number;
}

export interface TrenchesSnapshot {
  readonly stages: Readonly<Record<TrenchesStage, readonly TrenchesToken[]>>;
  readonly truncatedStages: readonly TrenchesStage[];
}

export interface SecuritySnapshot {
  readonly tokenKey: string;
  readonly address: string;
  readonly isHoneypot: boolean;
  readonly isOpenSource: boolean;
  readonly isOwnerRenounced?: boolean;
  readonly buyTax: number;
  readonly sellTax: number;
  readonly top10HolderRate: number;
  readonly isBlacklist?: boolean;
  readonly burnStatus?: string;
  readonly lockPercent?: number;
  readonly conflicts: readonly string[];
}

export interface Candle {
  readonly timeMs: number;
  readonly open: number;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly volumeUsd: number;
  readonly amountToken: number;
}

export interface PoolSnapshot {
  readonly tokenKey: string;
  readonly address: string;
  readonly poolAddress: string;
  readonly quoteAddress: string;
  readonly exchange: string;
  readonly liquidity: number;
  readonly baseReserve: number;
  readonly quoteReserve: number;
  readonly price?: number;
  readonly creationTimestampMs: number;
}
