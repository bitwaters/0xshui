import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { openDatabase, PersistenceRepository } from "../src/db/index.js";
import { adaptRank, unwrapSuccessEnvelope, type RankToken } from "../src/gmgn/index.js";
import { SnapshotCoordinator, TokenWindowStore } from "../src/realtime/index.js";

const NOW = 1_787_614_000_000;

function rankToken(): RankToken {
  const fixture = JSON.parse(
    readFileSync("test/fixtures/gmgn/rank-double.json", "utf8"),
  ) as unknown;
  const token = adaptRank(unwrapSuccessEnvelope(fixture).data, "1m")[0];
  assert.ok(token);
  return token;
}

test("successful source diffs create atomic changes without false exits", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const windowStore = new TokenWindowStore();
    let now = NOW;
    const coordinator = new SnapshotCoordinator({
      repository,
      windowStore,
      now: () => now,
    });
    const token = rankToken();

    assert.equal(coordinator.commitRank("rank_1m", [token], now), null, "first success is baseline");
    now += 1_000;
    assert.equal(coordinator.commitRank("rank_1m", [token], now), null, "identical data is not fresh");
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM token_snapshots").get() as { count: number })
        .count,
      1,
    );

    const improved: RankToken = { ...token, rank: 2, buys: token.buys + 1 };
    now += 1_000;
    assert.equal(coordinator.commitRank("rank_1m", [improved], now), null);
    const securitySeq = repository.appendSecurityEvent({
      tokenKey: token.tokenKey,
      capturedAt: now,
      status: "passed",
      payload: {},
      adapterVersion: "test",
    });
    assert.equal(securitySeq, 2);

    // A failed poll never calls commit; the previous successful state remains intact.
    now += 1_000;
    assert.equal(coordinator.commitRank("rank_1m", [], now), 3);
    const rows = database
      .prepare("SELECT ingest_seq, event_type, payload_json FROM token_snapshots ORDER BY ingest_seq")
      .all() as Array<{ ingest_seq: number; event_type: string; payload_json: string }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map(({ ingest_seq, event_type }) => ({ ingest_seq, event_type })),
      [
        { ingest_seq: 1, event_type: "enter" },
        { ingest_seq: 3, event_type: "exit" },
      ],
    );
    assert.equal((JSON.parse(rows[1]?.payload_json ?? "{}") as { rank: number | null }).rank, null);
    assert.equal(TokenWindowStore.effectiveRank(null), 101);
    assert.equal(windowStore.isSourceFresh("rank_1m", now + 9_999), true);
    assert.equal(windowStore.isSourceFresh("rank_1m", now + 10_001), false);
  } finally {
    database.close();
  }
});

test("token windows retain only 60 seconds and at most ten ordered events", () => {
  const store = new TokenWindowStore();
  store.markSourceSuccess("rank_1m", NOW + 20_000);
  for (let sequence = 1; sequence <= 12; sequence += 1) {
    store.add("token", {
      ingestSeq: sequence,
      source: "rank_1m",
      eventType: "update",
      capturedAt: NOW + sequence * 1_000,
      data: { rank: sequence },
    });
  }
  assert.deepEqual(
    store.getEvents("token", NOW + 12_000).map(({ ingestSeq }) => ingestSeq),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.equal(store.getFreshEvents("token", "rank_1m", NOW + 20_000).length, 3);
  assert.equal(store.getEvents("token", NOW + 80_000).length, 0);
});

test("current source state survives event expiry without manufacturing updates", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const windowStore = new TokenWindowStore();
    let now = NOW;
    const coordinator = new SnapshotCoordinator({
      repository,
      windowStore,
      now: () => now,
    });
    const token = rankToken();
    coordinator.commitRank("rank_5m", [{ ...token, interval: "5m" }], now);

    now += 61_000;
    coordinator.commitRank("rank_5m", [{ ...token, interval: "5m" }], now);
    assert.equal(windowStore.getEvents(token.tokenKey, now).length, 0);
    assert.equal(windowStore.getCurrent<RankToken>(token.tokenKey, "rank_5m")?.rank, token.rank);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM token_snapshots").get() as { count: number })
        .count,
      1,
    );

    now += 1_000;
    coordinator.commitRank("rank_5m", [], now);
    assert.equal(windowStore.getCurrent(token.tokenKey, "rank_5m"), undefined);
    assert.equal(windowStore.getConsecutiveRankMisses(token.tokenKey, "rank_5m"), 1);

    now += 1_000;
    coordinator.commitRank("rank_5m", [], now);
    assert.equal(windowStore.getConsecutiveRankMisses(token.tokenKey, "rank_5m"), 2);

    now += 1_000;
    coordinator.commitRank("rank_5m", [{ ...token, interval: "5m" }], now);
    assert.equal(windowStore.getConsecutiveRankMisses(token.tokenKey, "rank_5m"), 0);
  } finally {
    database.close();
  }
});

test("a failed snapshot transaction does not advance the in-memory baseline", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    let now = NOW;
    const coordinator = new SnapshotCoordinator({
      repository,
      windowStore: new TokenWindowStore(),
      ordinarySnapshotIntervalMs: 1,
      now: () => now,
    });
    const token = rankToken();
    coordinator.commitRank("rank_1m", [token], now);
    const improved: RankToken = { ...token, rank: 1, buys: token.buys + 10 };

    database.exec(`
      CREATE TRIGGER reject_snapshot
      BEFORE INSERT ON token_snapshots
      BEGIN
        SELECT RAISE(FAIL, 'forced snapshot failure');
      END
    `);
    now += 1_000;
    assert.throws(() => coordinator.commitRank("rank_1m", [improved], now));
    database.exec("DROP TRIGGER reject_snapshot");

    now += 1_000;
    assert.equal(coordinator.commitRank("rank_1m", [improved], now), 2);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM token_snapshots").get() as { count: number })
        .count,
      2,
    );
  } finally {
    database.close();
  }
});

test("duplicate tokens fail the response without changing its source baseline", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    let now = NOW;
    const coordinator = new SnapshotCoordinator({
      repository,
      windowStore: new TokenWindowStore(),
      now: () => now,
    });
    const token = rankToken();
    coordinator.commitRank("rank_1m", [token], now);

    now += 1_000;
    assert.throws(
      () => coordinator.commitRank("rank_1m", [token, { ...token, rank: 1 }], now),
      /Duplicate token/,
    );
    now += 1_000;
    assert.equal(coordinator.commitRank("rank_1m", [], now), 2);
  } finally {
    database.close();
  }
});

test("ordinary updates are persisted at five-second resolution while high-priority updates are complete", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const token = rankToken();
    let now = NOW;
    let high = false;
    const coordinator = new SnapshotCoordinator({
      repository,
      windowStore: new TokenWindowStore(),
      isHighPriority: () => high,
      now: () => now,
    });
    coordinator.commitRank("rank_1m", [token], now);
    for (let second = 1; second <= 6; second += 1) {
      now = NOW + second * 1_000;
      coordinator.commitRank("rank_1m", [{ ...token, buys: token.buys + second }], now);
    }
    high = true;
    now += 1_000;
    coordinator.commitRank("rank_1m", [{ ...token, buys: token.buys + 7 }], now);
    now += 1_000;
    coordinator.commitRank("rank_1m", [{ ...token, buys: token.buys + 8 }], now);
    now += 1_000;
    coordinator.commitRank("rank_1m", [], now);

    const rows = database
      .prepare("SELECT event_type AS eventType, sampling_level AS samplingLevel, captured_at AS capturedAt FROM token_snapshots ORDER BY ingest_seq")
      .all();
    assert.deepEqual(rows, [
      { eventType: "enter", samplingLevel: "ordinary", capturedAt: NOW },
      { eventType: "update", samplingLevel: "ordinary", capturedAt: NOW + 5_000 },
      { eventType: "update", samplingLevel: "high", capturedAt: NOW + 7_000 },
      { eventType: "update", samplingLevel: "high", capturedAt: NOW + 8_000 },
      { eventType: "exit", samplingLevel: "high", capturedAt: NOW + 9_000 },
    ]);
  } finally {
    database.close();
  }
});
