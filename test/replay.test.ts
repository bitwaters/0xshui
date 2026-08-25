import assert from "node:assert/strict";
import test from "node:test";

import { loadAppConfig } from "../src/config/index.js";
import {
  openDatabase,
  PersistenceRepository,
  type SnapshotEvent,
  type SqliteDatabase,
} from "../src/db/index.js";
import type { RankToken, SecuritySnapshot, TrenchesToken } from "../src/gmgn/index.js";
import { ReplayRunner } from "../src/replay/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";

function rank(rankValue: number, holders: number, swaps: number): RankToken {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    interval: "1m",
    rank: rankValue,
    price: 1,
    marketCap: 100_000,
    liquidity: 20_000,
    swaps,
    buys: 30,
    sells: 10,
    holderCount: holders,
    creatorAddress: CREATOR,
    isHoneypot: false,
    isOpenSource: true,
    isOwnerRenounced: true,
    top10HolderRate: 0.2,
    lockPercent: 0.8,
  };
}

function trench(): TrenchesToken {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    stage: "completed",
    price: 1,
    marketCap: 100_000,
    holderCount: 20,
    creatorAddress: CREATOR,
  };
}

function security(): SecuritySnapshot {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    isHoneypot: false,
    isOpenSource: true,
    isOwnerRenounced: true,
    buyTax: 0,
    sellTax: 0,
    top10HolderRate: 0.2,
    lockPercent: 0.8,
    conflicts: [],
  };
}

function event(payload: RankToken | TrenchesToken, capturedAt: number): SnapshotEvent {
  return {
    tokenKey: TOKEN,
    eventType: "update",
    capturedAt,
    sourceCapturedAt: capturedAt,
    samplingLevel: "high",
    payload,
    upstreamFilterVersion: "gmgn-safe-v1",
    adapterVersion: "gmgn-adapter-v1",
  };
}

function seed(database: SqliteDatabase): {
  readonly repository: PersistenceRepository;
  readonly strictVersion: number;
} {
  const repository = new PersistenceRepository(database);
  const config = loadAppConfig();
  repository.registerConfigVersion(config, NOW - 1);
  const strictVersion = repository.registerConfigVersion(
    {
      ...config,
      fast_rank_trigger: { ...config.fast_rank_trigger, max_rank_1m: 1 },
      cross_source_trigger: { ...config.cross_source_trigger, max_rank_1m: 1 },
    },
    NOW,
  );
  repository.appendSourceBatch("rank_1m", [event(rank(50, 10, 10), NOW)]);
  repository.appendSourceBatch("trenches", [event(trench(), NOW + 1_000)]);
  repository.appendSourceBatch("rank_1m", [event(rank(5, 20, 30), NOW + 5_000)]);
  repository.appendSecurityEvent({
    tokenKey: TOKEN,
    capturedAt: NOW + 6_000,
    status: "passed",
    payload: security(),
    adapterVersion: "gmgn-adapter-v1",
  });
  return { repository, strictVersion };
}

test("replay is deterministic, ordered, versioned, and never mutates history", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const { repository, strictVersion } = seed(database);
    const before = {
      snapshots: (database.prepare("SELECT COUNT(*) AS count FROM token_snapshots").get() as { count: number }).count,
      security: (database.prepare("SELECT COUNT(*) AS count FROM security_checks").get() as { count: number }).count,
      next: repository.getRuntimeState<number>("next_ingest_seq"),
    };
    const options = { repository, configVersion: 1, from: NOW, to: NOW + 10_000 };
    const first = new ReplayRunner(options).run();
    const second = new ReplayRunner(options).run();
    assert.deepEqual(second, first);
    assert.equal(first.signalCount, 1);
    assert.equal(first.signals[0]?.trigger, "fast_rank");
    assert.deepEqual(first.decisions.map(({ action }) => action), ["security_pending", "qualified"]);
    assert.deepEqual(first.upstreamFilterVersions, ["gmgn-safe-v1"]);
    assert.deepEqual(first.adapterVersions, ["gmgn-adapter-v1"]);
    assert.deepEqual(first.samplingLevels, ["high"]);
    assert.equal(first.replaySelectedQuality.signals, 1);
    assert.equal(first.replaySelectedQuality.coverage15, 0);
    assert.ok(first.scopeLimitations.some((line) => line.includes("5 秒")));

    const stricter = new ReplayRunner({ ...options, configVersion: strictVersion }).run();
    assert.equal(stricter.signalCount, 0);
    assert.deepEqual(
      {
        snapshots: (database.prepare("SELECT COUNT(*) AS count FROM token_snapshots").get() as { count: number }).count,
        security: (database.prepare("SELECT COUNT(*) AS count FROM security_checks").get() as { count: number }).count,
        next: repository.getRuntimeState<number>("next_ingest_seq"),
      },
      before,
    );
  } finally {
    database.close();
  }
});

test("replay fails closed on malformed stored payloads and invalid ranges", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    repository.registerConfigVersion(loadAppConfig(), NOW);
    repository.appendSourceBatch("rank_1m", [
      { ...event(rank(10, 20, 30), NOW), payload: { tokenKey: TOKEN } },
    ]);
    assert.throws(
      () => new ReplayRunner({ repository, from: NOW, to: NOW + 1 }).run(),
      /Invalid stored Rank payload/,
    );
    assert.throws(() => repository.listReplayEvents(NOW, NOW), /Replay range/);
  } finally {
    database.close();
  }
});
