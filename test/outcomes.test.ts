import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, PersistenceRepository, type SqliteDatabase } from "../src/db/index.js";
import type { Candle, PoolSnapshot } from "../src/gmgn/index.js";
import {
  OutcomeWorker,
  calculateOutcome,
  calculateSnapshotOutcome,
  type OutcomeDataSource,
  type PoolLookup,
} from "../src/outcomes/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const QUOTE = "0x3333333333333333333333333333333333333333";
const FIFTEEN = 15 * 60_000;
const HOUR = 60 * 60_000;

function candle(timeMs: number, close: number, high = close, low = close): Candle {
  return {
    timeMs,
    open: close,
    close,
    high,
    low,
    volumeUsd: 1,
    amountToken: 1,
  };
}

function pool(liquidity = 10_000): PoolSnapshot {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    poolAddress: POOL,
    quoteAddress: QUOTE,
    exchange: "pancakeswap",
    liquidity,
    baseReserve: 1,
    quoteReserve: 1,
    creationTimestampMs: NOW - HOUR,
  };
}

function setupSent(
  lifecycle: "curve" | "graduated" = "graduated",
  sentAt = NOW,
): { readonly database: SqliteDatabase; readonly repository: PersistenceRepository } {
  const database = openDatabase({ path: ":memory:" });
  const repository = new PersistenceRepository(database);
  const version = repository.registerConfigVersion({ test: true }, sentAt);
  repository.upsertCandidateDecision({
    tokenKey: TOKEN,
    lifecycle,
    state: "qualified",
    priority: "normal",
    configVersion: version,
    decision: { trigger: lifecycle === "curve" ? "curve_acceleration" : "fast_rank" },
    firstDiscoveredAt: sentAt - 5_000,
    qualifiedAt: sentAt - 2_000,
    securityCompletedAt: sentAt - 1_000,
    now: sentAt,
  });
  repository.tryMarkDeliveryPending(TOKEN, sentAt);
  repository.markSent(TOKEN, 123, sentAt, 1, 100_000, [FIFTEEN, HOUR]);
  return { database, repository };
}

function dataSource(
  klines: readonly Candle[] | Error,
  poolLookup: PoolLookup | Error = {
    status: "found",
    pool: pool(),
    hasAlternativePool: false,
  },
): OutcomeDataSource {
  return {
    fetchKlines: async () => {
      if (klines instanceof Error) throw klines;
      return klines;
    },
    fetchPool: async () => {
      if (poolLookup instanceof Error) throw poolLookup;
      return poolLookup;
    },
  };
}

function outcomeRow(database: SqliteDatabase, checkpointMs = FIFTEEN): {
  readonly state: string;
  readonly attempt_count: number;
  readonly result_json: string | null;
} {
  return database
    .prepare(
      "SELECT state, attempt_count, result_json FROM signal_outcomes WHERE checkpoint_ms = ?",
    )
    .get(checkpointMs) as {
    state: string;
    attempt_count: number;
    result_json: string | null;
  };
}

function addRankPrice(
  repository: PersistenceRepository,
  source: "rank_1m" | "rank_5m",
  capturedAt: number,
  price: number,
  eventType: "enter" | "update" | "exit" = "update",
): void {
  repository.appendSourceBatch(source, [
    {
      tokenKey: TOKEN,
      eventType,
      capturedAt,
      sourceCapturedAt: capturedAt,
      samplingLevel: "high",
      payload: { tokenKey: TOKEN, address: TOKEN, price },
      upstreamFilterVersion: "test",
      adapterVersion: "test",
    },
  ]);
}

test("outcome calculator excludes the signal candle and any future candle", () => {
  const sentAt = 1_005_000;
  const result = calculateOutcome(
    sentAt,
    1,
    FIFTEEN,
    [
      candle(990_000, 50, 100, 0.01),
      candle(1_020_000, 2, 3, 0.5),
      candle(1_290_000, 2.5, 3.5, 0.8),
      candle(1_860_000, 4, 4.5, 2),
      candle(1_890_000, 99, 100, 0.01),
    ],
    [
      { capturedAt: 1_000_000, price: 100 },
      { capturedAt: 1_010_000, price: 1.5 },
      { capturedAt: 1_020_000, price: 100 },
    ],
  );
  assert.equal(result.return1m, 1);
  assert.equal(result.return5m, 1);
  assert.equal(result.return15m, 3);
  assert.equal(result.mfe, 3.5);
  assert.equal(result.mae, -0.5);
  assert.equal(result.timeTo2xMs, 45_000);
  assert.equal(result.candleCount, 3);
});

test("snapshot outcome reports observed multiples without filling stale checkpoints", () => {
  const result = calculateSnapshotOutcome(
    NOW,
    1,
    FIFTEEN,
    [
      { capturedAt: NOW + 30_000, price: 1.1 },
      { capturedAt: NOW + 55_000, price: 1.3 },
      { capturedAt: NOW + 120_000, price: 2.2 },
      { capturedAt: NOW + FIFTEEN - 40_000, price: 0.8 },
    ],
    "rank_1m",
  );
  assert.notEqual(result, null);
  assert.ok(Math.abs((result?.return1m ?? Infinity) - 0.3) < Number.EPSILON);
  assert.equal(result?.return15m, undefined);
  assert.ok(Math.abs((result?.mfe ?? Infinity) - 1.2) < 1e-12);
  assert.ok(Math.abs((result?.mae ?? Infinity) + 0.2) < 1e-12);
  assert.equal(result?.timeTo2xMs, 120_000);
  assert.equal(result?.priceSource, "rank_1m");
  assert.equal(result?.snapshotCount, 4);
});

test("sent transition atomically creates both persistent checkpoint jobs", () => {
  const { database } = setupSent();
  try {
    assert.deepEqual(
      database
        .prepare("SELECT checkpoint_ms, due_at, state FROM signal_outcomes ORDER BY checkpoint_ms")
        .all(),
      [
        { checkpoint_ms: FIFTEEN, due_at: NOW + FIFTEEN, state: "pending" },
        { checkpoint_ms: HOUR, due_at: NOW + HOUR, state: "pending" },
      ],
    );
  } finally {
    database.close();
  }
});

test("15-minute worker calculates 1m, 5m, 15m, MFE, and MAE", async () => {
  const { database, repository } = setupSent();
  try {
    const first = Math.ceil(NOW / 30_000) * 30_000;
    const candles = Array.from({ length: 30 }, (_, index) =>
      candle(first + index * 30_000, 1 + index / 100, 1.5, 0.8),
    );
    const worker = new OutcomeWorker({
      repository,
      dataSource: dataSource(candles),
      now: () => NOW + FIFTEEN,
    });
    assert.equal(await worker.runDue(), 1);
    const row = outcomeRow(database);
    assert.equal(row.state, "completed");
    const result = JSON.parse(row.result_json ?? "{}") as Record<string, number>;
    assert.equal(typeof result.return1m, "number");
    assert.equal(typeof result.return5m, "number");
    assert.equal(typeof result.return15m, "number");
    assert.equal(result.mfe, 0.5);
    assert.ok(Math.abs((result.mae ?? Infinity) + 0.2) < Number.EPSILON);
  } finally {
    database.close();
  }
});

test("outcome worker prioritizes real signals before research samples", async () => {
  const { database, repository } = setupSent();
  try {
    const configVersion = repository.getConfigVersion()?.version;
    assert.notEqual(configVersion, undefined);
    assert.equal(
      repository.createResearchSample({
        tokenKey: "0x4444444444444444444444444444444444444444",
        configVersion: configVersion ?? 0,
        sampledAt: NOW,
        lifecycle: "graduated",
        baselinePrice: 1,
        feature: { test: true },
        detectorVersion: "detector-v1",
        upstreamFilterVersion: "safe-v1",
        adapterVersion: "adapter-v1",
        outcomeCheckpointsMs: [FIFTEEN, HOUR],
      }),
      true,
    );
    const worker = new OutcomeWorker({
      repository,
      dataSource: {
        fetchKlines: async () => [],
        fetchPool: async (tokenKey) => ({
          status: "found",
          pool: { ...pool(), tokenKey, address: tokenKey },
          hasAlternativePool: false,
        }),
      },
      now: () => NOW + FIFTEEN,
    });
    assert.equal(await worker.runDue(1), 1);
    assert.equal(outcomeRow(database).state, "no_trade");
    assert.equal(repository.countPendingResearchOutcomes(), 2);
    assert.equal(await worker.runDue(1), 1);
    const research = repository.listResearchSamples(0, NOW + 1)[0];
    assert.equal(research?.outcomes.find((item) => item.checkpointMs === FIFTEEN)?.state, "no_trade");
    assert.equal(repository.countPendingResearchOutcomes(), 1);
  } finally {
    database.close();
  }
});

test("empty Kline needs corroboration for no_trade and pool_removed", async () => {
  const stillLiquid = setupSent();
  try {
    const worker = new OutcomeWorker({
      repository: stillLiquid.repository,
      dataSource: dataSource([]),
      now: () => NOW + FIFTEEN,
    });
    await worker.runDue();
    const row = outcomeRow(stillLiquid.database);
    assert.equal(row.state, "no_trade");
    assert.equal((JSON.parse(row.result_json ?? "{}") as { return15m: number }).return15m, 0);
  } finally {
    stillLiquid.database.close();
  }

  const removed = setupSent();
  try {
    removed.repository.savePoolBaseline(TOKEN, pool(), NOW);
    const worker = new OutcomeWorker({
      repository: removed.repository,
      dataSource: dataSource([], { status: "missing", hasAlternativePool: false }),
      now: () => NOW + FIFTEEN,
    });
    await worker.runDue();
    const row = outcomeRow(removed.database);
    assert.equal(row.state, "pool_removed");
    assert.deepEqual(
      JSON.parse(row.result_json ?? "{}"),
      { return1m: -1, return5m: -1, return15m: -1, mfe: 0, mae: -1, candleCount: 0 },
    );
  } finally {
    removed.database.close();
  }

  const unsupported = setupSent();
  try {
    const worker = new OutcomeWorker({
      repository: unsupported.repository,
      dataSource: dataSource([], { status: "missing", hasAlternativePool: false }),
      now: () => NOW + FIFTEEN,
    });
    await worker.runDue();
    assert.equal(outcomeRow(unsupported.database).state, "api_missing");
  } finally {
    unsupported.database.close();
  }
});

test("empty Kline prefers 1m Rank prices and falls back to 5m Rank", async () => {
  const preferred = setupSent();
  try {
    addRankPrice(preferred.repository, "rank_5m", NOW + 30_000, 5);
    addRankPrice(preferred.repository, "rank_1m", NOW + 40_000, 2.5);
    addRankPrice(preferred.repository, "rank_1m", NOW + 50_000, 9, "exit");
    const worker = new OutcomeWorker({
      repository: preferred.repository,
      dataSource: dataSource([]),
      now: () => NOW + FIFTEEN,
    });
    await worker.runDue();
    const row = outcomeRow(preferred.database);
    const result = JSON.parse(row.result_json ?? "{}") as Record<string, unknown>;
    assert.equal(row.state, "completed");
    assert.equal(result.priceSource, "rank_1m");
    assert.equal(result.snapshotCount, 1);
    assert.equal(result.mfe, 1.5);
  } finally {
    preferred.database.close();
  }

  const fallback = setupSent();
  try {
    addRankPrice(fallback.repository, "rank_5m", NOW + 30_000, 3);
    const worker = new OutcomeWorker({
      repository: fallback.repository,
      dataSource: dataSource([]),
      now: () => NOW + FIFTEEN,
    });
    await worker.runDue();
    const result = JSON.parse(outcomeRow(fallback.database).result_json ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(result.priceSource, "rank_5m");
    assert.equal(result.mfe, 2);
  } finally {
    fallback.database.close();
  }
});

test("existing terminal outcomes are requeued once and backfilled without Kline requests", async () => {
  const { database, repository } = setupSent();
  try {
    addRankPrice(repository, "rank_1m", NOW + 30_000, 2);
    database
      .prepare(`
        UPDATE signal_outcomes
        SET state = CASE WHEN checkpoint_ms = ${HOUR} THEN 'pool_removed' ELSE 'no_trade' END,
          attempt_count = 1,
          result_json = '{"mfe":0}', completed_at = due_at
      `)
      .run();
    const configVersion = repository.getConfigVersion()?.version;
    assert.notEqual(configVersion, undefined);
    repository.createResearchSample({
      tokenKey: TOKEN,
      configVersion: configVersion ?? 0,
      sampledAt: NOW,
      lifecycle: "graduated",
      baselinePrice: 1,
      feature: {},
      detectorVersion: "test",
      upstreamFilterVersion: "test",
      adapterVersion: "test",
      outcomeCheckpointsMs: [FIFTEEN, HOUR],
    });
    database
      .prepare(`
        UPDATE research_outcomes SET state = 'api_missing', attempt_count = 3,
          result_json = '{"reason":"old"}', completed_at = due_at
      `)
      .run();

    assert.deepEqual(repository.requeueSnapshotFallbackOutcomes(NOW + HOUR + 1), {
      signals: 2,
      research: 2,
    });
    assert.deepEqual(repository.requeueSnapshotFallbackOutcomes(NOW + HOUR + 2), {
      signals: 0,
      research: 0,
    });
    assert.deepEqual(
      database
        .prepare("SELECT state, attempt_count FROM signal_outcomes ORDER BY checkpoint_ms")
        .all(),
      [
        { state: "pending", attempt_count: 0 },
        { state: "pending", attempt_count: 0 },
      ],
    );
    let klineCalls = 0;
    const worker = new OutcomeWorker({
      repository,
      dataSource: {
        fetchKlines: async () => {
          klineCalls += 1;
          throw new Error("historical backfill must not refetch Kline");
        },
        fetchPool: async () => {
          throw new Error("confirmed historical removal must not require another Pool request");
        },
      },
      now: () => NOW + HOUR + 3,
    });
    assert.equal(await worker.runDue(4), 4);
    assert.equal(klineCalls, 0);
    const oneHour = JSON.parse(outcomeRow(database, HOUR).result_json ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(outcomeRow(database, HOUR).state, "completed");
    assert.equal(oneHour.priceSource, "rank_1m");
    assert.equal(oneHour.poolRemoved, true);
  } finally {
    database.close();
  }
});

test("a graduated token can retain a multiple hit and also confirm later pool removal", async () => {
  const { database, repository } = setupSent();
  try {
    repository.savePoolBaseline(TOKEN, pool(), NOW);
    const first = Math.ceil(NOW / 30_000) * 30_000;
    const candles = Array.from({ length: 120 }, (_, index) =>
      candle(first + index * 30_000, 1, 2.5, 0.5),
    );
    const worker = new OutcomeWorker({
      repository,
      dataSource: dataSource(candles, { status: "missing", hasAlternativePool: false }),
      now: () => NOW + HOUR,
    });
    assert.equal(await worker.runDue(), 2);
    const row = outcomeRow(database, HOUR);
    const result = JSON.parse(row.result_json ?? "{}") as Record<string, unknown>;
    assert.equal(row.state, "completed");
    assert.equal(result.mfe, 1.5);
    assert.equal(result.poolRemoved, true);
  } finally {
    database.close();
  }
});

test("curve no_trade requires fresh snapshots on both sides with unchanged swaps", async () => {
  const { database, repository } = setupSent("curve");
  try {
    const dueAt = NOW + FIFTEEN;
    repository.appendSourceBatch("trenches", [
      {
        tokenKey: TOKEN,
        eventType: "update",
        capturedAt: dueAt - 1_000,
        sourceCapturedAt: dueAt - 1_000,
        samplingLevel: "high",
        payload: {
          tokenKey: TOKEN,
          address: TOKEN,
          stage: "near_completion",
          curveSwapsTotal: 100,
        },
        upstreamFilterVersion: "test",
        adapterVersion: "test",
      },
    ]);
    repository.appendSourceBatch("trenches", [
      {
        tokenKey: TOKEN,
        eventType: "update",
        capturedAt: dueAt + 500,
        sourceCapturedAt: dueAt + 500,
        samplingLevel: "high",
        payload: {
          tokenKey: TOKEN,
          address: TOKEN,
          stage: "near_completion",
          curveSwapsTotal: 100,
        },
        upstreamFilterVersion: "test",
        adapterVersion: "test",
      },
    ]);
    const worker = new OutcomeWorker({
      repository,
      dataSource: dataSource([]),
      now: () => dueAt + 500,
    });
    await worker.runDue();
    assert.equal(outcomeRow(database).state, "no_trade");
  } finally {
    database.close();
  }
});

test("a curve that graduates before the checkpoint uses Pool corroboration", async () => {
  const { database, repository } = setupSent("curve");
  try {
    const dueAt = NOW + FIFTEEN;
    repository.appendSourceBatch("trenches", [
      {
        tokenKey: TOKEN,
        eventType: "update",
        capturedAt: dueAt - 1_000,
        sourceCapturedAt: dueAt - 1_000,
        samplingLevel: "high",
        payload: { tokenKey: TOKEN, address: TOKEN, stage: "completed" },
        upstreamFilterVersion: "test",
        adapterVersion: "test",
      },
    ]);
    const worker = new OutcomeWorker({
      repository,
      dataSource: dataSource([]),
      now: () => dueAt,
    });
    await worker.runDue();
    const row = outcomeRow(database);
    const result = JSON.parse(row.result_json ?? "{}") as Record<string, unknown>;
    assert.equal(row.state, "no_trade");
    assert.equal(result.graduation, "graduated");
  } finally {
    database.close();
  }
});

test("mismatched source tokens fail closed", async () => {
  const curveSetup = setupSent("curve");
  try {
    const dueAt = NOW + FIFTEEN;
    const other = "0x9999999999999999999999999999999999999999";
    for (const capturedAt of [dueAt - 1_000, dueAt + 500]) {
      curveSetup.repository.appendSourceBatch("trenches", [
        {
          tokenKey: TOKEN,
          eventType: "update",
          capturedAt,
          sourceCapturedAt: capturedAt,
          samplingLevel: "high",
          payload: {
            tokenKey: other,
            address: other,
            stage: "near_completion",
            curveSwapsTotal: 100,
          },
          upstreamFilterVersion: "test",
          adapterVersion: "test",
        },
      ]);
    }
    const worker = new OutcomeWorker({
      repository: curveSetup.repository,
      dataSource: dataSource([]),
      now: () => dueAt + 500,
    });
    await worker.runDue();
    assert.equal(outcomeRow(curveSetup.database).state, "pending");
  } finally {
    curveSetup.database.close();
  }

  const poolSetup = setupSent();
  try {
    const other = "0x9999999999999999999999999999999999999999";
    const worker = new OutcomeWorker({
      repository: poolSetup.repository,
      dataSource: dataSource([], {
        status: "found",
        pool: { ...pool(), tokenKey: other, address: other },
        hasAlternativePool: false,
      }),
      now: () => NOW + FIFTEEN,
    });
    await worker.runDue();
    assert.equal(outcomeRow(poolSetup.database).state, "pending");
  } finally {
    poolSetup.database.close();
  }
});

test("overlapping worker ticks do not process the same jobs twice", async () => {
  const { database, repository } = setupSent();
  try {
    let release: (() => void) | undefined;
    let calls = 0;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new OutcomeWorker({
      repository,
      dataSource: {
        fetchKlines: async () => {
          calls += 1;
          await blocked;
          return [];
        },
        fetchPool: async () => ({
          status: "found",
          pool: pool(),
          hasAlternativePool: false,
        }),
      },
      now: () => NOW + FIFTEEN,
    });
    const first = worker.runDue();
    await Promise.resolve();
    assert.equal(await worker.runDue(), 0);
    release?.();
    assert.equal(await first, 1);
    assert.equal(calls, 1);
  } finally {
    database.close();
  }
});

test("unavailable market data retries three times then becomes terminal within grace", async () => {
  const { database, repository } = setupSent();
  try {
    let now = NOW + FIFTEEN;
    const worker = new OutcomeWorker({
      repository,
      dataSource: dataSource(new Error("unavailable")),
      now: () => now,
    });
    await worker.runDue();
    assert.deepEqual(outcomeRow(database), {
      state: "pending",
      attempt_count: 1,
      result_json: '{"reason":"market_api_failed"}',
    });
    now += 3 * 60_000;
    await worker.runDue();
    now += 3 * 60_000;
    await worker.runDue();
    const row = outcomeRow(database);
    assert.equal(row.state, "retry_exhausted");
    assert.equal(row.attempt_count, 3);
    assert.ok(now <= NOW + FIFTEEN + 10 * 60_000);
  } finally {
    database.close();
  }
});

test("graduated pool baseline capture is asynchronous and stores only valid pools", async () => {
  const { database, repository } = setupSent();
  try {
    const worker = new OutcomeWorker({
      repository,
      dataSource: dataSource([], {
        status: "found",
        pool: pool(),
        hasAlternativePool: false,
      }),
      now: () => NOW + 1,
    });
    assert.equal(await worker.capturePoolBaseline(TOKEN), true);
    assert.ok(
      (database.prepare("SELECT pool_baseline_json AS pool FROM signals").get() as { pool: string })
        .pool.includes(POOL),
    );
  } finally {
    database.close();
  }
});
