import type { Candle, PoolSnapshot } from "../gmgn/index.js";

export type GraduationStatus = "graduated" | "not_graduated" | "unknown";

export interface RealtimePrice {
  readonly capturedAt: number;
  readonly price: number;
}

export interface CalculatedOutcome {
  readonly return1m?: number;
  readonly return5m?: number;
  readonly return15m?: number;
  readonly return1h?: number;
  readonly mfe: number;
  readonly mae: number;
  readonly candleCount: number;
  readonly graduation?: GraduationStatus;
}

export type PoolLookup =
  | {
      readonly status: "found";
      readonly pool: PoolSnapshot;
      readonly hasAlternativePool: boolean;
    }
  | { readonly status: "missing"; readonly hasAlternativePool: boolean };

export interface OutcomeDataSource {
  readonly fetchKlines: (
    tokenKey: string,
    fromUnixSeconds: number,
    toUnixSeconds: number,
  ) => Promise<readonly Candle[]>;
  readonly fetchPool: (tokenKey: string) => Promise<PoolLookup>;
}
