import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, PersistenceRepository, type StatisticsSignalRow } from "../src/db/index.js";
import {
  StatsService,
  aggregateStatistics,
  localDateKey,
  parseStatsRequest,
  renderStatisticsCard,
  resolveStatsRange,
} from "../src/stats/index.js";

const NOW = Date.UTC(2033, 4, 18, 12);
const FIFTEEN = 15 * 60_000;
const HOUR = 60 * 60_000;

function row(
  id: number,
  overrides: Partial<StatisticsSignalRow> = {},
): StatisticsSignalRow {
  return {
    signalId: id,
    configVersion: 1,
    tokenKey: `0x${String(id).padStart(40, "0")}`,
    lifecycle: "graduated",
    state: "sent",
    decision: { trigger: "fast_rank" },
    qualifiedAt: NOW - 2 * HOUR - 3_000,
    securityCompletedAt: NOW - 2 * HOUR - 1_000,
    sentAt: NOW - 2 * HOUR,
    confirmedAt: null,
    outcomes: [],
    ...overrides,
  };
}

function outcome(checkpointMs: number, state: string, result: unknown) {
  return { checkpointMs, state: state as "completed", result };
}

test("statistics use fixed sent-only denominators and exclude unknown outcomes", () => {
  const signals: StatisticsSignalRow[] = [
    row(1, {
      lifecycle: "curve",
      state: "confirmed",
      decision: { trigger: "curve_acceleration" },
      outcomes: [
        outcome(FIFTEEN, "completed", {
          return1m: 0.1,
          return5m: 0.2,
          return15m: 0.25,
          mfe: 0.4,
          mae: -0.1,
        }),
        outcome(HOUR, "completed", {
          return1h: 1.2,
          mfe: 1.5,
          mae: -0.2,
          graduation: "graduated",
        }),
      ],
    }),
    row(2, {
      lifecycle: "curve",
      outcomes: [
        outcome(FIFTEEN, "no_trade", { return1m: 0, return5m: 0, return15m: 0, mfe: 0, mae: 0 }),
        outcome(HOUR, "no_trade", {
          return1h: 0,
          mfe: 0,
          mae: 0,
          graduation: "not_graduated",
        }),
      ],
    }),
    row(3, {
      state: "confirmed",
      decision: { evidence: { trigger: "cross_source" } },
      outcomes: [
        outcome(FIFTEEN, "pool_removed", { return15m: -1, mfe: -1, mae: -1 }),
        outcome(HOUR, "pool_removed", { return1h: -1, mfe: -1, mae: -1 }),
      ],
    }),
    row(4, {
      outcomes: [
        outcome(FIFTEEN, "api_missing", { reason: "missing" }),
        outcome(HOUR, "retry_exhausted", { reason: "missing" }),
      ],
    }),
    row(5, {
      sentAt: NOW - 5 * 60_000,
      qualifiedAt: NOW - 5 * 60_000 - 1_000,
      outcomes: [outcome(FIFTEEN, "pending", null)],
    }),
  ];
  const stats = aggregateStatistics(signals, NOW);
  assert.equal(stats.signals, 5);
  assert.equal(stats.due15, 4);
  assert.equal(stats.pending15, 1);
  assert.equal(stats.evaluated15, 3);
  assert.equal(stats.hit15, 1);
  assert.equal(stats.hitRate15, 1 / 3);
  assert.equal(stats.coverage15, 3 / 4);
  assert.equal(stats.evaluated1h, 3);
  assert.equal(stats.largeGain1h, 1);
  assert.equal(stats.largeGainRate1h, 1 / 3);
  assert.equal(stats.medianReturn15m, 0);
  assert.equal(stats.medianMfe15, 0);
  assert.equal(stats.medianMae15, -0.1);
  assert.equal(stats.graduatedCurves, 1);
  assert.equal(stats.knownCurveGraduations, 2);
  assert.equal(stats.curveGraduationRate, 0.5);
  assert.equal(stats.confirmed, 2);
  assert.equal(stats.confirmationRate, 0.4);
  assert.equal(stats.medianLatencyMs, 3_000);
  assert.deepEqual(
    stats.sources.map(({ source, signals: count }) => ({ source, count })),
    [
      { source: "cross_source", count: 1 },
      { source: "curve_acceleration", count: 1 },
      { source: "double_confirmation", count: 2 },
      { source: "fast_rank", count: 3 },
    ],
  );
});

test("statistics card discloses samples, coverage, touch metrics, and disclaimer", () => {
  const stats = aggregateStatistics([], NOW);
  const text = renderStatisticsCard(stats, "今日", true);
  assert.ok(text.includes("样本不足"));
  assert.ok(text.includes("数据覆盖率"));
  assert.ok(text.includes("价格触达研究指标"));
  assert.ok(text.includes("不代表安全或可成交收益"));
  assert.ok(text.includes("双榜确认"));
});

test("unknown source metadata is normalized before HTML rendering", () => {
  const stats = aggregateStatistics(
    [row(1, { decision: { trigger: "<script>alert(1)</script>" } })],
    NOW,
  );
  const text = renderStatisticsCard(stats, "今日", true);
  assert.ok(text.includes("未知来源"));
  assert.ok(!text.includes("<script>"));
});

test("stats request parsing and timezone-aware day ranges are deterministic", () => {
  assert.equal(parseStatsRequest(""), "current");
  assert.equal(parseStatsRequest(" 7D "), "7d");
  assert.equal(parseStatsRequest("detail"), "detail");
  assert.equal(parseStatsRequest("90d"), null);
  assert.equal(localDateKey(NOW, "Asia/Shanghai"), "2033-05-18");
  const range = resolveStatsRange("today", NOW, "Asia/Shanghai");
  assert.equal(range.from, Date.UTC(2033, 4, 17, 16));
  assert.equal(range.to, Date.UTC(2033, 4, 18, 16));
  assert.equal(resolveStatsRange("7d", NOW, "Asia/Shanghai").from, NOW - 7 * 86_400_000);
});

test("daily report claim prevents a duplicate after restart", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const configVersion = repository.registerConfigVersion({ stats: "current" }, NOW - HOUR);
    const service = new StatsService({
      repository,
      timeZone: "Asia/Shanghai",
      hitGain: 0.3,
      largeGain: 1,
      configVersion,
      now: () => NOW,
    });
    const sent: string[] = [];
    assert.equal(
      await service.sendDailyOnce(async (text) => {
        sent.push(text);
      }),
      true,
    );
    const afterRestart = new StatsService({
      repository: new PersistenceRepository(database),
      timeZone: "Asia/Shanghai",
      hitGain: 0.3,
      largeGain: 1,
      configVersion,
      now: () => NOW,
    });
    assert.equal(await afterRestart.sendDailyOnce(async () => undefined), false);
    assert.equal(sent.length, 1);
    assert.equal(repository.getRuntimeState("last_daily_report_date"), "2033-05-18");
  } finally {
    database.close();
  }
});
