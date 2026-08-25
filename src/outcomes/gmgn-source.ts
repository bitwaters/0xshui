import { adaptKline, adaptPool, type GmgnHttpClient } from "../gmgn/index.js";
import type { OutcomeDataSource, PoolLookup } from "./types.js";

function isExplicitMissingPool(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

export function createGmgnOutcomeDataSource(client: GmgnHttpClient): OutcomeDataSource {
  return {
    fetchKlines: async (tokenKey, fromUnixSeconds, toUnixSeconds) => {
      const raw = await client.fetchKline(tokenKey, fromUnixSeconds, toUnixSeconds);
      return adaptKline(raw.data);
    },
    fetchPool: async (tokenKey): Promise<PoolLookup> => {
      const raw = await client.fetchPool(tokenKey);
      if (isExplicitMissingPool(raw.data)) {
        return { status: "missing", hasAlternativePool: false };
      }
      return {
        status: "found",
        pool: adaptPool(raw.data),
        hasAlternativePool: false,
      };
    },
  };
}
