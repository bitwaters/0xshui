import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadAppConfig } from "../src/config/index.js";
import { openDatabase, PersistenceRepository } from "../src/db/index.js";
import type { PoolSnapshot, RankToken, SecuritySnapshot, TrenchesToken } from "../src/gmgn/index.js";
import { createLogger } from "../src/logging/index.js";
import {
  AcceptanceService,
  acceptanceConfigKey,
  GmgnRequestMetrics,
  HealthMonitor,
  MetricsService,
} from "../src/operations/index.js";
import { TokenWindowStore, WeightedRateLimiter } from "../src/realtime/index.js";
import { SignalEngine, assessDeliveryLiquidity } from "../src/runtime/index.js";
import { TelegramPublisher, type TelegramGateway } from "../src/telegram/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";

function rank(rankValue: number, capturedAt: number): { token: RankToken; capturedAt: number } {
  return {
    capturedAt,
    token: {
      tokenKey: TOKEN,
      address: TOKEN,
      interval: "1m",
      rank: rankValue,
      price: 1,
      marketCap: 100_000,
      liquidity: 20_000,
      swaps: 100 + (50 - rankValue),
      buys: 80,
      sells: 20,
      holderCount: 100 + (50 - rankValue),
      creatorAddress: CREATOR,
      isHoneypot: false,
      isOpenSource: true,
      isOwnerRenounced: true,
      top10HolderRate: 0.2,
      lockPercent: 0.8,
    },
  };
}

function trench(): TrenchesToken {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    stage: "completed",
    price: 1,
    marketCap: 100_000,
    holderCount: 100,
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

function pool(): PoolSnapshot {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    poolAddress: "0x3333333333333333333333333333333333333333",
    quoteAddress: "0x4444444444444444444444444444444444444444",
    exchange: "test",
    liquidity: 20_000,
    baseReserve: 1,
    quoteReserve: 20_000,
    creationTimestampMs: NOW - 60_000,
  };
}

test("runtime engine reaches sent and confirms by editing the original message", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const base = loadAppConfig();
    const config = {
      ...base,
      confirmation: { ...base.confirmation, min_rank_1m_improvement: 1 },
    };
    const configVersion = repository.registerConfigVersion(config, NOW);
    const windowStore = new TokenWindowStore();
    for (const [sequence, item] of [rank(50, NOW - 5_000), rank(5, NOW)].entries()) {
      windowStore.add(TOKEN, {
        ingestSeq: sequence + 1,
        source: "rank_1m",
        eventType: "update",
        capturedAt: item.capturedAt,
        data: item.token,
      });
    }
    windowStore.add(TOKEN, {
      ingestSeq: 3,
      source: "trenches",
      eventType: "enter",
      capturedAt: NOW - 1_000,
      data: trench(),
    });
    windowStore.markSourceSuccess("rank_1m", NOW);
    windowStore.markSourceSuccess("trenches", NOW);
    const edits: number[] = [];
    const gateway: TelegramGateway = {
      sendMessage: async () => ({ message_id: 88 }),
      editMessageText: async (_chat, messageId) => {
        edits.push(messageId);
      },
    };
    const publisher = new TelegramPublisher({
      api: gateway,
      repository,
      chatId: "-1001",
      now: () => NOW,
      sleep: async () => undefined,
    });
    const health = new HealthMonitor(true);
    health.markHealthy("storage", NOW);
    const cached = { capturedAt: NOW, snapshot: security() };
    const engine = new SignalEngine({
      config,
      configVersion,
      repository,
      windowStore,
      security: {
        preheat: async () => cached.snapshot,
        getFreshForSend: async () => cached.snapshot,
        getCached: () => cached,
      },
      pool: {
        getFreshForSend: async () => ({ snapshot: pool(), capturedAt: NOW }),
      },
      publisher,
      logger: createLogger({ level: "fatal" }),
      health,
      now: () => NOW,
    });
    await engine.processToken(TOKEN, NOW);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "sent");
    assert.equal(repository.countPendingOutcomes(), 2);
    assert.equal(repository.countPendingResearchOutcomes(), 2);
    assert.equal(repository.listResearchSamples(0, NOW + 1).length, 1);
    const attempted = database
      .prepare("SELECT telegram_attempted_at AS value FROM signals WHERE token_key = ?")
      .get(TOKEN) as { value: number };
    assert.equal(attempted.value, NOW);

    const rank1a = rank(5, NOW + 1_000);
    const rank1b = rank(4, NOW + 2_000);
    for (const [sequence, item] of [rank1a, rank1b].entries()) {
      windowStore.add(TOKEN, {
        ingestSeq: 4 + sequence,
        source: "rank_1m",
        eventType: "update",
        capturedAt: item.capturedAt,
        data: item.token,
      });
      windowStore.add(TOKEN, {
        ingestSeq: 6 + sequence,
        source: "rank_5m",
        eventType: "update",
        capturedAt: item.capturedAt,
        data: { ...item.token, interval: "5m", rank: sequence === 0 ? 40 : 30 },
      });
    }
    windowStore.markSourceSuccess("rank_1m", NOW + 2_000);
    windowStore.markSourceSuccess("rank_5m", NOW + 2_000);
    windowStore.replaceCurrentSource(
      "rank_1m",
      [{ tokenKey: TOKEN, data: rank1b.token }],
      NOW + 2_000,
    );
    windowStore.replaceCurrentSource(
      "rank_5m",
      [{ tokenKey: TOKEN, data: { ...rank1b.token, interval: "5m", rank: 30 } }],
      NOW + 2_000,
    );
    await engine.processToken(TOKEN, NOW + 2_000);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "confirmed");
    assert.deepEqual(edits, [88]);
  } finally {
    database.close();
  }
});

test("runtime delivery recheck continues a qualified candidate after its trigger window", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const config = loadAppConfig();
    const configVersion = repository.registerConfigVersion(config, NOW);
    const windowStore = new TokenWindowStore();
    const baseline = rank(25, NOW - 5_000);
    const triggered = rank(8, NOW);
    for (const [sequence, item] of [baseline, triggered].entries()) {
      windowStore.add(TOKEN, {
        ingestSeq: sequence + 1,
        source: "rank_1m",
        eventType: "update",
        capturedAt: item.capturedAt,
        data: item.token,
      });
    }
    windowStore.add(TOKEN, {
      ingestSeq: 3,
      source: "trenches",
      eventType: "enter",
      capturedAt: NOW,
      data: trench(),
    });
    windowStore.markSourceSuccess("rank_1m", NOW);
    windowStore.markSourceSuccess("trenches", NOW);

    let now = NOW;
    let cached: { capturedAt: number; snapshot: SecuritySnapshot } | null = null;
    let sends = 0;
    const publisher = new TelegramPublisher({
      api: {
        sendMessage: async () => {
          sends += 1;
          return { message_id: 99 };
        },
        editMessageText: async () => undefined,
      },
      repository,
      chatId: "-1001",
      now: () => now,
      sleep: async () => undefined,
    });
    const engine = new SignalEngine({
      config,
      configVersion,
      repository,
      windowStore,
      security: {
        preheat: async () => cached?.snapshot ?? null,
        getFreshForSend: async () => cached?.snapshot ?? null,
        getCached: () => cached,
      },
      pool: {
        getFreshForSend: async () => ({ snapshot: pool(), capturedAt: now }),
      },
      publisher,
      logger: createLogger({ level: "fatal" }),
      health: new HealthMonitor(true),
      now: () => now,
    });

    await engine.processToken(TOKEN, now);
    assert.equal(repository.getDetectionState(TOKEN)?.state, "security_pending");

    now += 20_000;
    cached = { capturedAt: now, snapshot: security() };
    windowStore.replaceCurrentSource(
      "rank_1m",
      [{ tokenKey: TOKEN, data: triggered.token }],
      now,
    );
    windowStore.markSourceSuccess("rank_1m", now);
    await engine.processToken(TOKEN, now);

    assert.equal(sends, 1);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "sent");
  } finally {
    database.close();
  }
});

test("delivery liquidity fails closed and classifies thin and curve evidence", () => {
  const common = { now: NOW, maximumAgeMs: 10_000, curveSourceFresh: true } as const;
  assert.deepEqual(
    assessDeliveryLiquidity({ ...common, lifecycle: "graduated", pool: null }),
    { ok: false, reason: "pool_liquidity_unavailable" },
  );
  assert.deepEqual(
    assessDeliveryLiquidity({
      ...common,
      lifecycle: "graduated",
      pool: { snapshot: { ...pool(), liquidity: 0 }, capturedAt: NOW },
    }),
    { ok: false, reason: "pool_liquidity_unavailable" },
  );
  assert.deepEqual(
    assessDeliveryLiquidity({
      ...common,
      lifecycle: "graduated",
      pool: { snapshot: { ...pool(), liquidity: 4_999 }, capturedAt: NOW },
    }),
    { ok: true, liquidity: 4_999, thin: true },
  );
  assert.deepEqual(
    assessDeliveryLiquidity({ ...common, lifecycle: "curve", curveLiquidity: 5_000 }),
    { ok: true, liquidity: 5_000, thin: false },
  );
  assert.deepEqual(
    assessDeliveryLiquidity({
      ...common,
      lifecycle: "curve",
      curveSourceFresh: false,
      curveLiquidity: 5_000,
    }),
    { ok: false, reason: "curve_liquidity_unavailable" },
  );
});

test("health readiness fails closed for each required dependency", () => {
  const health = new HealthMonitor(true);
  health.markHealthy("storage", NOW);
  health.markHealthy("telegram", NOW);
  health.markHealthy("gmgn", NOW);
  assert.equal(health.snapshot(NOW).ready, true);

  health.markDegraded("gmgn", NOW + 1);
  assert.equal(health.snapshot(NOW + 1).ready, false);
  health.markHealthy("gmgn", NOW + 2);

  health.markFailed("security", NOW + 1);
  assert.equal(health.snapshot(NOW + 2).ready, false);
  health.markHealthy("security", NOW + 3);

  health.markFailed("telegram", NOW + 4);
  assert.equal(health.snapshot(NOW + 4).ready, false);
  health.markHealthy("telegram", NOW + 5);

  health.markFailed("storage", NOW + 6);
  assert.equal(health.snapshot(NOW + 6).ready, false);
  health.markHealthy("storage", NOW + 7);

  assert.equal(health.snapshot(NOW + 11_000).ready, false, "stale GMGN must remove readiness");
  health.stop();
  assert.equal(health.snapshot(NOW + 11_000).alive, false);
});

test("isolated token Security failures degrade health while a consecutive outage fails it", () => {
  const health = new HealthMonitor(false);
  health.markHealthy("storage", NOW);
  health.markHealthy("gmgn", NOW);
  health.markHealthy("telegram", NOW);
  health.recordSecurityResult(false, NOW);
  assert.equal(health.snapshot(NOW).components.security, "degraded");
  assert.equal(health.snapshot(NOW).ready, true);
  health.recordSecurityResult(false, NOW + 1);
  health.recordSecurityResult(false, NOW + 2);
  assert.equal(health.snapshot(NOW + 2).components.security, "failed");
  assert.equal(health.snapshot(NOW + 2).ready, false);
  health.recordSecurityResult(true, NOW + 3);
  assert.equal(health.snapshot(NOW + 3).components.security, "healthy");
  assert.equal(health.snapshot(NOW + 3).ready, true);
});

test("acceptance reports sample progress without treating elapsed time as a gate", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const config = loadAppConfig();
    const configKey = acceptanceConfigKey(config);
    const configVersion = repository.registerConfigVersion(config, NOW);
    const service = new AcceptanceService(repository, configKey, configVersion);

    const initialReport = service.report(NOW);
    assert.equal(initialReport.shadowStartedAt, NOW);
    assert.equal(initialReport.validSamples, 0);
    assert.equal(initialReport.gates.validSamples100, false);
    assert.equal(initialReport.eligibleForManualApproval, false);
    assert.equal(repository.getRuntimeState(`shadow_started_at:${configKey}`), null);

    assert.equal(service.ensureShadowStarted(NOW), NOW);
    assert.equal(service.recordHeartbeat(NOW + 60_000), NOW);
    assert.equal(service.recordHeartbeat(NOW + 7 * 60_000), NOW + 7 * 60_000);
    assert.equal(service.recordHeartbeat(NOW - 1), NOW - 1, "clock rollback resets the run");
  } finally {
    database.close();
  }
});

test("acceptance fingerprint ignores deployment mode but changes with signal parameters", () => {
  const base = loadAppConfig();
  assert.equal(
    acceptanceConfigKey({
      ...base,
      mode: "production",
      telegram: { ...base.telegram, enabled: true },
    }),
    acceptanceConfigKey(base),
  );
  assert.notEqual(
    acceptanceConfigKey({
      ...base,
      fast_rank_trigger: {
        ...base.fast_rank_trigger,
        max_rank_1m: base.fast_rank_trigger.max_rank_1m + 1,
      },
    }),
    acceptanceConfigKey(base),
  );
});

test("acceptance requires sample, path, coverage, latency, and API quality gates", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const config = loadAppConfig();
    const configVersion = repository.registerConfigVersion(config, NOW - 3 * 60 * 60_000);
    const configKey = acceptanceConfigKey(config);
    const sentAt = NOW - 2 * 60 * 60_000;
    const triggers = Array.from({ length: 100 }, (_, index) =>
      index < 34 ? "curve_acceleration" : index < 67 ? "fast_rank" : "cross_source",
    );
    repository.appendSourceBatch(
      "rank_1m",
      triggers.map((_trigger, index) => {
        const tokenKey = `0x${(index + 1).toString(16).padStart(40, "0")}`;
        return {
          tokenKey,
          eventType: "enter" as const,
          capturedAt: sentAt - 8_000,
          sourceCapturedAt: sentAt - 8_000,
          samplingLevel: "high" as const,
          payload: { ...rank(5, sentAt - 8_000).token, tokenKey, address: tokenKey },
          upstreamFilterVersion: "test",
          adapterVersion: "test",
        };
      }),
    );
    for (const [index, trigger] of triggers.entries()) {
      const tokenKey = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      repository.upsertCandidateDecision({
        tokenKey,
        lifecycle: trigger === "curve_acceleration" ? "curve" : "graduated",
        state: "qualified",
        priority: "high",
        configVersion,
        decision: { evidence: { trigger } },
        firstDiscoveredAt: sentAt - 8_000,
        qualifiedAt: sentAt - 4_000,
        securityCompletedAt: sentAt - 1_000,
        now: sentAt - 4_000,
      });
      repository.tryMarkDeliveryPending(tokenKey, sentAt - 100);
      repository.markSent(tokenKey, 100 + index, sentAt, 1, 100_000);
      const signalId = (
        database.prepare("SELECT id FROM signals WHERE token_key = ?").get(tokenKey) as {
          id: number;
        }
      ).id;
      repository.saveOutcome({
        signalId,
        checkpointMs: 60 * 60_000,
        dueAt: sentAt + 60 * 60_000,
        state: "completed",
        attemptCount: 1,
        result: { return1h: 0.2, mfe: 0.4, mae: -0.1 },
        completedAt: sentAt + 60 * 60_000,
        now: sentAt + 60 * 60_000,
      });
    }
    repository.addRuntimeCounter(`gmgn_request_attempts:${configKey}`, 10_000, NOW);
    repository.addRuntimeCounter(`gmgn_request_successes:${configKey}`, 9_900, NOW);
    const metrics = new MetricsService(repository).collect(0, NOW + 1, configVersion);
    assert.equal(metrics.qualifiedToSent.p95, 4_000);
    assert.equal(metrics.fastSourceToSent.p95, 8_000);
    assert.equal(metrics.outcomeCoverage1h, 1);
    assert.equal(metrics.multipleHitRates["1.2x"], 1);
    assert.equal(metrics.multipleHitRates["1.5x"], 0);
    assert.ok(Math.abs((metrics.medianPeakMultiple ?? 0) - 1.4) < Number.EPSILON);
    assert.equal(metrics.noTradeRate, 0);
    assert.equal(metrics.confirmedPoolRemovalRate, 0);
    const service = new AcceptanceService(repository, configKey, configVersion);
    assert.equal(service.report(NOW).validSamples, 100);
    assert.deepEqual(service.report(NOW).triggerSamples, {
      cross_source: 33,
      curve_acceleration: 34,
      fast_rank: 33,
    });
    assert.equal(service.report(NOW).eligibleForManualApproval, true);
    assert.equal(service.report(NOW).productionActivation, "blocked");
    assert.equal(service.approve(NOW).productionActivation, "approved");
    assert.equal(service.reject(NOW + 1).productionActivation, "blocked");
  } finally {
    database.close();
  }
});

test("rate limiter stop interrupts a persisted cooldown wait", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const limiter = new WeightedRateLimiter({
      ratePerSecond: 10,
      capacity: 10,
      initialCooldownUntil: NOW + 60_000,
      repository: new PersistenceRepository(database),
      now: () => NOW,
      sleep: async () => new Promise<void>(() => undefined),
    });
    const pending = limiter.acquire(1, "realtime");
    await Promise.resolve();
    limiter.stop();
    await assert.rejects(pending, /stopped/);
  } finally {
    database.close();
  }
});

test("GMGN request metrics export bounded P50/P95 and interval success rate", () => {
  const metrics = new GmgnRequestMetrics(3);
  metrics.record({ path: "/a", durationMs: 100, success: true });
  metrics.record({ path: "/a", durationMs: 300, success: false });
  metrics.record({ path: "/b", durationMs: 200, success: true });
  metrics.record({ path: "/b", durationMs: 400, success: true });
  const expected = {
    attempts: 4,
    successes: 3,
    successRate: 0.75,
    latency: { samples: 3, p50: 300, p95: 400 },
  };
  assert.deepEqual(metrics.snapshot(), expected);
  assert.deepEqual(metrics.snapshot(true), expected);
  assert.deepEqual(metrics.snapshot(), {
    attempts: 0,
    successes: 0,
    successRate: null,
    latency: { samples: 0, p50: null, p95: null },
  });
});

test("production source has no trading key, signature, subprocess, or gmgn-cli dependency", () => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  visit("src");
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n").toLowerCase();
  for (const forbidden of ["gmgn-cli", "gmgn_private_key", "x-signature", "child_process"]) {
    assert.ok(!source.includes(forbidden), `production source contains forbidden ${forbidden}`);
  }
});
