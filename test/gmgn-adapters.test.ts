import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  adaptKline,
  adaptPool,
  adaptRank,
  adaptSecurity,
  adaptTrenches,
  GmgnContractError,
  unwrapSuccessEnvelope,
} from "../src/gmgn/index.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`test/fixtures/gmgn/${name}`, "utf8")) as unknown;
}

function fixtureData(name: string): unknown {
  return unwrapSuccessEnvelope(fixture(name)).data;
}

test("adapts current double-envelope Rank fields into strict BSC models", () => {
  const tokens = adaptRank(fixtureData("rank-double.json"), "1m");
  assert.equal(tokens.length, 1);
  const token = tokens[0];
  assert.equal(token?.tokenKey, "0x1111111111111111111111111111111111111111");
  assert.equal(token?.rank, 1);
  assert.equal(token?.buys, 55);
  assert.equal(token?.sells, 25);
  assert.equal(token?.lockPercent, 0.95);
  assert.equal(token?.creationTimestampMs, 1_787_610_000_000);
});

test("treats GMGN zero sentinel as an unknown optional creation timestamp", () => {
  const payload = fixtureData("rank-double.json") as { rank: Array<Record<string, unknown>> };
  payload.rank[0] = { ...payload.rank[0], creation_timestamp: 0 };
  const token = adaptRank(payload, "1m")[0];
  assert.equal(token?.creationTimestampMs, undefined);

  payload.rank[0] = { ...payload.rank[0], creation_timestamp: -1 };
  assert.throws(() => adaptRank(payload, "1m"), /integer >= 1/);
});

test("adapts both observed Trenches stage aliases and curve cumulative fields", () => {
  const current = adaptTrenches(fixtureData("trenches-single.json"));
  assert.equal(current.stages.new_creation[0]?.curveSwapsTotal, 30);
  assert.equal(current.stages.near_completion[0]?.bondingProgress, 0.91);
  assert.equal(current.stages.completed.length, 1);

  const legacy = adaptTrenches(fixtureData("trenches-pump-single.json"));
  assert.equal(legacy.stages.near_completion.length, 1);

  const incomplete = adaptTrenches({
    new_creation: [
      {
        address: "0x4444444444444444444444444444444444444444",
        price: 0,
        holder_count: 1,
        swaps_24h: 0,
        progress: 0,
      },
    ],
    near_completion: [],
    completed: [],
  });
  assert.equal(incomplete.stages.new_creation[0]?.curveNetBuyTotal, undefined);

  const both = fixtureData("trenches-single.json") as Record<string, unknown>;
  both.pump = [];
  assert.throws(() => adaptTrenches(both), /both near_completion and pump/);
});

test("truncates an oversized Trenches stage to the documented per-stage maximum", () => {
  const item = {
    address: "0x1111111111111111111111111111111111111111",
    price: 0.1,
    holder_count: 10,
    swaps_24h: 10,
    net_buy_24h: 1,
    progress: 0.1,
  };
  const snapshot = adaptTrenches({
    new_creation: Array.from({ length: 81 }, (_, index) => ({
      ...item,
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    })),
    near_completion: [],
    completed: [],
  });
  assert.equal(snapshot.stages.new_creation.length, 80);
  assert.deepEqual(snapshot.truncatedStages, ["new_creation"]);
});

test("keeps the most mature Trenches stage for a cross-stage overlap", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const item = {
    address,
    price: 0.1,
    holder_count: 10,
    swaps_24h: 10,
    net_buy_24h: 1,
    progress: 0.5,
  };
  const snapshot = adaptTrenches({
    new_creation: [{ ...item, progress: 0.2 }],
    near_completion: [item],
    completed: [],
  });
  assert.equal(snapshot.stages.new_creation.length, 0);
  assert.equal(snapshot.stages.near_completion[0]?.tokenKey, address);

  assert.throws(
    () =>
      adaptTrenches({
        new_creation: [item, item],
        near_completion: [],
        completed: [],
      }),
    /Duplicate token.*within new_creation/,
  );
});

test("adapts mixed Security types and uses dangerous values on alias conflict", () => {
  const security = adaptSecurity(fixtureData("security-single.json"));
  assert.equal(security.isHoneypot, false);
  assert.equal(security.isOpenSource, true);
  assert.equal(security.sellTax, 0.01);
  assert.equal(security.top10HolderRate, 0.1522);
  assert.equal(security.lockPercent, 0.95);

  const conflicting = fixtureData("security-single.json") as Record<string, unknown>;
  conflicting.honeypot = 1;
  conflicting.open_source = 0;
  const dangerous = adaptSecurity(conflicting);
  assert.equal(dangerous.isHoneypot, true);
  assert.equal(dangerous.isOpenSource, false);
  assert.deepEqual([...dangerous.conflicts].sort(), [
    "security.is_honeypot",
    "security.is_open_source",
  ]);
});

test("fails closed on successful envelopes with invalid critical Security fields", () => {
  assert.throws(
    () => adaptSecurity(fixtureData("invalid-security-single.json")),
    GmgnContractError,
  );
  const invalidRatio = fixtureData("security-single.json") as Record<string, unknown>;
  invalidRatio.sell_tax = "1.5";
  assert.throws(() => adaptSecurity(invalidRatio), /between 0 and 1/);
});

test("normalizes Kline and Pool values while rejecting malformed contracts", () => {
  const candles = adaptKline(fixtureData("kline-single.json"));
  assert.equal(candles[0]?.timeMs, 1_787_611_170_000);
  assert.equal(candles[0]?.volumeUsd, 590.025752532);

  const pool = adaptPool(fixtureData("pool-single.json"));
  assert.equal(pool.exchange, "pancake_v2");
  assert.equal(pool.creationTimestampMs, 1_787_575_713_000);

  assert.throws(
    () =>
      adaptKline({
        list: [
          {
            time: 123,
            open: "1",
            close: "1",
            high: "1",
            low: "1",
            volume: "1",
            amount: "1",
          },
        ],
      }),
    /millisecond timestamps/,
  );
  assert.throws(
    () =>
      adaptPool({
        ...(fixtureData("pool-single.json") as Record<string, unknown>),
        pool_address: "bad",
      }),
    GmgnContractError,
  );
});

test("rejects unknown envelopes and malformed Rank critical fields", () => {
  assert.throws(() => unwrapSuccessEnvelope({ data: {} }), GmgnContractError);
  const payload = fixtureData("rank-double.json") as { rank: Array<Record<string, unknown>> };
  payload.rank[0] = { ...payload.rank[0], address: "0x123", buys: "many" };
  assert.throws(() => adaptRank(payload, "1m"), GmgnContractError);
});
