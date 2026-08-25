import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openDatabase,
  PersistenceRepository,
  runDatabaseMaintenance,
  type SnapshotEvent,
} from "../src/db/index.js";

const NOW = 2_000_000_000_000;
const DAY = 86_400_000;

function withDatabase(
  run: (context: {
    readonly path: string;
    readonly database: ReturnType<typeof openDatabase>;
    readonly repository: PersistenceRepository;
  }) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "gmgn-db-test-"));
  const path = join(directory, "signals.sqlite");
  const database = openDatabase({ path });
  try {
    run({ path, database, repository: new PersistenceRepository(database) });
  } finally {
    if (database.open) {
      database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function snapshot(
  tokenKey: string,
  capturedAt: number,
  samplingLevel: "high" | "ordinary" = "ordinary",
): SnapshotEvent {
  return {
    tokenKey,
    eventType: "enter",
    capturedAt,
    sourceCapturedAt: capturedAt,
    samplingLevel,
    payload: { tokenKey },
    upstreamFilterVersion: "safe-v1",
    adapterVersion: "adapter-v1",
  };
}

function addCandidate(
  repository: PersistenceRepository,
  configVersion: number,
  tokenKey: string,
  state: "qualified" | "observing" = "qualified",
  now = NOW,
): void {
  assert.equal(
    repository.upsertCandidateDecision({
      tokenKey,
      lifecycle: "curve",
      state,
      priority: "normal",
      configVersion,
      decision: { path: "curve" },
      firstDiscoveredAt: now - 1_000,
      now,
    }),
    true,
  );
}

test("migration configures required pragmas and is idempotent", () => {
  withDatabase(({ path, database }) => {
    assert.equal(database.pragma("user_version", { simple: true }), 3);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(database.pragma("auto_vacuum", { simple: true }), 2);
    assert.equal(database.pragma("busy_timeout", { simple: true }), 5_000);
    database.close();

    const reopened = openDatabase({ path });
    try {
      assert.equal(reopened.pragma("user_version", { simple: true }), 3);
      const tables = reopened
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      assert.deepEqual(
        tables.map(({ name }) => name).sort(),
        [
          "config_versions",
          "runtime_state",
          "security_checks",
          "signal_outcomes",
          "signals",
          "token_snapshots",
        ],
      );
      reopened.pragma("user_version = 4");
    } finally {
      reopened.close();
    }
    assert.throws(() => openDatabase({ path }), /newer than supported/);
  });
});

test("source batches and Security events share an atomic ingest sequence", () => {
  withDatabase(({ database, repository }) => {
    const first = repository.appendSourceBatch("rank_1m", [
      snapshot("0xbbb", NOW),
      snapshot("0xaaa", NOW),
    ]);
    assert.equal(first, 1);
    assert.throws(() =>
      repository.appendSourceBatch("rank_5m", [
        snapshot("0xduplicate", NOW),
        snapshot("0xduplicate", NOW),
      ]),
    );
    const second = repository.appendSecurityEvent({
      tokenKey: "0xaaa",
      capturedAt: NOW + 1,
      status: "passed",
      payload: { safe: true },
      adapterVersion: "adapter-v1",
    });
    assert.equal(second, 2, "rolled-back batches must not consume ingest_seq");

    const rows = database
      .prepare("SELECT ingest_seq, token_key FROM token_snapshots ORDER BY id")
      .all();
    assert.deepEqual(rows, [
      { ingest_seq: 1, token_key: "0xaaa" },
      { ingest_seq: 1, token_key: "0xbbb" },
    ]);
    assert.equal(repository.getRuntimeState<number>("next_ingest_seq"), 3);
  });
});

test("candidate updates are parameterized and delivery state is single-winner", () => {
  withDatabase(({ database, repository }) => {
    const configVersion = repository.registerConfigVersion({ b: 2, a: 1 }, NOW);
    assert.equal(repository.registerConfigVersion({ a: 1, b: 2 }, NOW + 1), configVersion);
    const tokenKey = "0xabc'); DROP TABLE signals; --";
    addCandidate(repository, configVersion, tokenKey, "observing");

    assert.equal(
      repository.upsertCandidateDecision({
        tokenKey,
        lifecycle: "curve",
        state: "qualified",
        priority: "high",
        configVersion,
        decision: { path: "curve", fresh: true },
        firstDiscoveredAt: NOW - 1_000,
        qualifiedAt: NOW + 1,
        now: NOW + 1,
      }),
      true,
    );
    assert.equal(repository.tryMarkDeliveryPending(tokenKey, NOW + 2), true);
    assert.equal(repository.tryMarkDeliveryPending(tokenKey, NOW + 2), false);
    assert.equal(
      repository.upsertCandidateDecision({
        tokenKey,
        lifecycle: "curve",
        state: "cancelled",
        priority: "normal",
        configVersion,
        decision: {},
        firstDiscoveredAt: NOW - 1_000,
        now: NOW + 3,
      }),
      false,
      "delivery states must block later first-signal decisions",
    );
    assert.equal(repository.markSent(tokenKey, 123, NOW + 4, 0.01, 10_000), true);
    assert.equal(repository.markConfirmed(tokenKey, NOW + 5), true);

    const row = database
      .prepare("SELECT state, telegram_message_id FROM signals WHERE token_key = ?")
      .get(tokenKey);
    assert.deepEqual(row, { state: "confirmed", telegram_message_id: 123 });

    const signal = database.prepare("SELECT id FROM signals WHERE token_key = ?").get(tokenKey) as {
      id: number;
    };
    repository.saveOutcome({
      signalId: signal.id,
      checkpointMs: 900_000,
      dueAt: NOW + 900_000,
      state: "completed",
      attemptCount: 1,
      result: { return: 0.4 },
      completedAt: NOW + 900_001,
      now: NOW + 900_001,
    });
    repository.saveOutcome({
      signalId: signal.id,
      checkpointMs: 900_000,
      dueAt: NOW + 900_000,
      state: "pending",
      attemptCount: 2,
      now: NOW + 900_002,
    });
    assert.equal(
      (
        database
          .prepare("SELECT state FROM signal_outcomes WHERE signal_id = ?")
          .get(signal.id) as { state: string }
      ).state,
      "completed",
      "terminal outcomes must not regress to pending",
    );
  });
});

test("startup recovery fails closed and restores persisted operational state", () => {
  withDatabase(({ path, database, repository }) => {
    const configVersion = repository.registerConfigVersion({ mode: "shadow" }, NOW);
    addCandidate(repository, configVersion, "0xpending");
    assert.equal(repository.tryMarkDeliveryPending("0xpending", NOW), true);

    addCandidate(repository, configVersion, "0xsent");
    database
      .prepare("UPDATE signals SET creator_address = ? WHERE token_key = ?")
      .run("0xcreator", "0xsent");
    assert.equal(repository.tryMarkDeliveryPending("0xsent", NOW), true);
    assert.equal(repository.markSent("0xsent", 456, NOW), true);
    const signal = database.prepare("SELECT id FROM signals WHERE token_key = '0xsent'").get() as {
      id: number;
    };
    repository.saveOutcome({
      signalId: signal.id,
      checkpointMs: 900_000,
      dueAt: NOW + 900_000,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW + 900_000,
      now: NOW,
    });
    repository.setRuntimeState("gmgn_cooldown_until", NOW + 300_000, NOW);
    repository.setRuntimeState("last_daily_report_date", "2033-05-18", NOW);

    database.close();
    const reopened = openDatabase({ path });
    try {
      const recovered = new PersistenceRepository(reopened).recoverStartupState(NOW + 10);
      assert.equal(recovered.convertedPendingDeliveries, 1);
      assert.deepEqual(
        recovered.blockedTokens.map(({ tokenKey, state }) => ({ tokenKey, state })),
        [
          { tokenKey: "0xpending", state: "delivery_unknown" },
          { tokenKey: "0xsent", state: "sent" },
        ],
      );
      assert.equal(recovered.recentSent.length, 1);
      assert.deepEqual(recovered.creatorCooldowns, [
        { creatorAddress: "0xcreator", sentAt: NOW },
      ]);
      assert.equal(recovered.pendingOutcomes.length, 2);
      assert.equal(recovered.cooldownUntil, NOW + 300_000);
      assert.equal(recovered.lastDailyReportDate, "2033-05-18");
    } finally {
      reopened.close();
    }
  });
});

test("maintenance applies retention and soft-limit snapshot priority", () => {
  withDatabase(({ path, database, repository }) => {
    repository.appendSourceBatch("trenches", [
      snapshot("old-ordinary", NOW - 15 * DAY),
      snapshot("fresh-ordinary", NOW, "ordinary"),
      snapshot("old-high", NOW - 15 * DAY, "high"),
      snapshot("fresh-high", NOW, "high"),
    ]);
    repository.appendSecurityEvent({
      tokenKey: "old-security",
      capturedAt: NOW - 15 * DAY,
      status: "passed",
      payload: {},
      adapterVersion: "adapter-v1",
    });

    const result = runDatabaseMaintenance(database, {
      databasePath: path,
      now: NOW,
      snapshotRetentionMs: 14 * DAY,
      signalRetentionMs: 180 * DAY,
      softLimitBytes: 1,
    });
    assert.equal(result.ordinarySnapshotsDeleted, 2);
    assert.equal(result.highSnapshotsDeleted, 1);
    assert.equal(result.securityChecksDeleted, 1);
    const remaining = database
      .prepare("SELECT token_key FROM token_snapshots ORDER BY token_key")
      .all();
    assert.deepEqual(remaining, [{ token_key: "fresh-high" }]);
  });
});

test("maintenance expires old signals and outcomes but preserves unresolved delivery", () => {
  withDatabase(({ path, database, repository }) => {
    const old = NOW - 181 * DAY;
    const expiredConfig = repository.registerConfigVersion({ version: "expired" }, old);
    addCandidate(repository, expiredConfig, "0xexpired", "qualified", old);
    assert.equal(repository.tryMarkDeliveryPending("0xexpired", old), true);
    assert.equal(repository.markSent("0xexpired", 777, old), true);
    const expiredSignal = database
      .prepare("SELECT id FROM signals WHERE token_key = '0xexpired'")
      .get() as { id: number };
    repository.saveOutcome({
      signalId: expiredSignal.id,
      checkpointMs: 900_000,
      dueAt: old,
      state: "completed",
      attemptCount: 1,
      result: { return: -1 },
      completedAt: old,
      now: old,
    });

    const protectedConfig = repository.registerConfigVersion({ version: "protected" }, old);
    addCandidate(repository, protectedConfig, "0xunresolved", "qualified", old);
    assert.equal(repository.tryMarkDeliveryPending("0xunresolved", old), true);

    const result = runDatabaseMaintenance(database, {
      databasePath: path,
      now: NOW,
      snapshotRetentionMs: 14 * DAY,
      signalRetentionMs: 180 * DAY,
      softLimitBytes: 5 * 1_073_741_824,
    });
    assert.equal(result.signalsDeleted, 1);
    assert.equal(result.configVersionsDeleted, 1);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM signal_outcomes").get() as { count: number })
        .count,
      0,
    );
    assert.deepEqual(database.prepare("SELECT token_key, state FROM signals").all(), [
      { token_key: "0xunresolved", state: "delivery_pending" },
    ]);
  });
});
