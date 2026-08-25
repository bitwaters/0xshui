import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadAppConfig } from "../src/config/index.js";
import { openDatabase, PersistenceRepository } from "../src/db/index.js";
import type { RankToken, SecuritySnapshot, TrenchesToken } from "../src/gmgn/index.js";
import { createLogger } from "../src/logging/index.js";
import {
  AcceptanceService,
  acceptanceConfigKey,
  GmgnRequestMetrics,
  HealthMonitor,
  MetricsService,
} from "../src/operations/index.js";
import { TokenWindowStore, WeightedRateLimiter } from "../src/realtime/index.js";
import { SignalEngine } from "../src/runtime/index.js";
import { TelegramPublisher, type TelegramGateway } from "../src/telegram/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const FIFTEEN = 15 * 60_000;

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
      publisher,
      logger: createLogger({ level: "fatal" }),
      health,
      now: () => NOW,
    });
    await engine.processToken(TOKEN, NOW);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "sent");
    assert.equal(repository.countPendingOutcomes(), 2);
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
    await engine.processToken(TOKEN, NOW + 2_000);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "confirmed");
    assert.deepEqual(edits, [88]);
  } finally {
    database.close();
  }
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

test("shadow acceptance requires a continuous heartbeat and does not start from a report", () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const configKey = acceptanceConfigKey(loadAppConfig());
    const service = new AcceptanceService(repository, configKey);

    const initialReport = service.report(NOW);
    assert.equal(initialReport.shadowStartedAt, NOW);
    assert.equal(initialReport.gates.shadowHeartbeatFresh, false);
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

test("acceptance gates require a matching fingerprint-bound manual approval", () => {

  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    const configVersion = repository.registerConfigVersion(loadAppConfig(), NOW - 80 * 60 * 60_000);
    const sentAt = NOW - 2 * 60 * 60_000;
    const configKey = acceptanceConfigKey(loadAppConfig());
    repository.setRuntimeState(`shadow_started_at:${configKey}`, NOW - 73 * 60 * 60_000);
    repository.setRuntimeState(`shadow_last_heartbeat:${configKey}`, NOW);
    repository.appendSourceBatch("rank_1m", [
      {
        tokenKey: TOKEN,
        eventType: "enter",
        capturedAt: sentAt - 8_000,
        sourceCapturedAt: sentAt - 8_000,
        samplingLevel: "high",
        payload: rank(5, sentAt - 8_000).token,
        upstreamFilterVersion: "test",
        adapterVersion: "test",
      },
    ]);
    repository.upsertCandidateDecision({
      tokenKey: TOKEN,
      lifecycle: "graduated",
      state: "qualified",
      priority: "high",
      configVersion,
      decision: { evidence: { trigger: "fast_rank" } },
      firstDiscoveredAt: sentAt - 8_000,
      qualifiedAt: sentAt - 4_000,
      securityCompletedAt: sentAt - 1_000,
      now: sentAt - 4_000,
    });
    repository.tryMarkDeliveryPending(TOKEN, sentAt - 100);
    repository.markSent(TOKEN, 99, sentAt, 1, 100_000);
    const signalId = (database.prepare("SELECT id FROM signals WHERE token_key = ?").get(TOKEN) as { id: number }).id;
    repository.saveOutcome({
      signalId,
      checkpointMs: FIFTEEN,
      dueAt: sentAt + FIFTEEN,
      state: "completed",
      attemptCount: 1,
      result: { return15m: 0.4, mfe: 0.5, mae: -0.1 },
      completedAt: sentAt + FIFTEEN,
      now: sentAt + FIFTEEN,
    });
    const metrics = new MetricsService(repository).collect(NOW - 73 * 60 * 60_000, NOW + 1);
    assert.equal(metrics.qualifiedToSent.p95, 4_000);
    assert.equal(metrics.fastSourceToSent.p95, 8_000);
    assert.equal(metrics.outcomeCoverage15, 1);
    const service = new AcceptanceService(repository, configKey);
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
