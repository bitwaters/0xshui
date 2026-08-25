import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, PersistenceRepository } from "../src/db/index.js";
import { GmgnHttpClient } from "../src/gmgn/index.js";
import { WeightedRateLimiter } from "../src/realtime/index.js";

const NOW = 1_787_614_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("weighted limiter enforces budget and stages recovery by priority", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    let now = NOW;
    const sleeps: number[] = [];
    const limiter = new WeightedRateLimiter({
      ratePerSecond: 10,
      capacity: 10,
      initialCooldownUntil: NOW + 5_000,
      repository,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await limiter.acquire(5, "realtime");
    await limiter.acquire(1, "security");
    await limiter.acquire(1, "offline");
    assert.deepEqual(sleeps, [5_000, 1_000, 1_000]);
    assert.equal(repository.getRuntimeState("gmgn_cooldown_until"), null);

    await limiter.acquire(10, "realtime");
    await limiter.acquire(1, "realtime");
    assert.equal(sleeps.at(-1), 100);
  } finally {
    database.close();
  }
});

test("client retries consume limiter weight and 429 cooldown is persisted", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    let now = NOW;
    const limiterSleeps: number[] = [];
    const limiter = new WeightedRateLimiter({
      ratePerSecond: 3,
      capacity: 3,
      repository,
      now: () => now,
      sleep: async (milliseconds) => {
        limiterSleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    let attempts = 0;
    const client = new GmgnHttpClient({
      apiKey: "test",
      baseUrl: "https://openapi.gmgn.ai",
      userAgent: "test",
      timeoutMs: 5_000,
      maxResponseBytes: 1_000,
      now: () => now,
      uuid: () => `00000000-0000-4000-8000-${String(++attempts).padStart(12, "0")}`,
      sleep: async () => undefined,
      beforeAttempt: limiter.beforeAttempt,
      onRateLimit: limiter.onRateLimit,
      fetchImplementation: async () =>
        attempts === 1
          ? new Response(null, { status: 503 })
          : jsonResponse({ code: 0, data: {} }),
    });

    await client.fetchTrenches();
    assert.deepEqual(limiterSleeps, [1_000]);

    const limitedClient = new GmgnHttpClient({
      apiKey: "test",
      baseUrl: "https://openapi.gmgn.ai",
      userAgent: "test",
      timeoutMs: 5_000,
      maxResponseBytes: 1_000,
      now: () => now,
      uuid: () => "00000000-0000-4000-8000-000000000099",
      sleep: async () => undefined,
      beforeAttempt: limiter.beforeAttempt,
      onRateLimit: limiter.onRateLimit,
      fetchImplementation: async () =>
        jsonResponse({ code: 429, error: "RATE_LIMIT_BANNED" }, 429),
    });
    await assert.rejects(limitedClient.fetchRank("1m"));
    assert.equal(
      repository.getRuntimeState<number>("gmgn_cooldown_until"),
      now + 300_000,
    );
  } finally {
    database.close();
  }
});

test("priority queue serves realtime before an older offline request", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    let now = NOW;
    const sleepers: Array<() => void> = [];
    const limiter = new WeightedRateLimiter({
      ratePerSecond: 1,
      capacity: 1,
      repository: new PersistenceRepository(database),
      now: () => now,
      sleep: (milliseconds) =>
        new Promise<void>((resolve) => {
          sleepers.push(() => {
            now += milliseconds;
            resolve();
          });
        }),
    });
    await limiter.acquire(1, "realtime");
    const order: string[] = [];
    const offline = limiter.acquire(1, "offline").then(() => order.push("offline"));
    await Promise.resolve();
    const realtime = limiter.acquire(1, "realtime").then(() => order.push("realtime"));
    sleepers.shift()?.();
    await realtime;
    assert.deepEqual(order, ["realtime"]);
    sleepers.shift()?.();
    await offline;
    assert.deepEqual(order, ["realtime", "offline"]);
    limiter.stop();
  } finally {
    database.close();
  }
});

test("same-priority FIFO does not let a lighter request bypass a heavy head", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    let now = NOW;
    const sleepers: Array<() => void> = [];
    const limiter = new WeightedRateLimiter({
      ratePerSecond: 3,
      capacity: 3,
      repository: new PersistenceRepository(database),
      now: () => now,
      sleep: (milliseconds) =>
        new Promise<void>((resolve) => {
          sleepers.push(() => {
            now += milliseconds;
            resolve();
          });
        }),
    });
    await limiter.acquire(3, "realtime");
    const order: string[] = [];
    const heavy = limiter.acquire(3, "realtime").then(() => order.push("heavy"));
    await Promise.resolve();
    const light = limiter.acquire(1, "realtime").then(() => order.push("light"));
    sleepers.shift()?.();
    await heavy;
    assert.deepEqual(order, ["heavy"]);
    sleepers.shift()?.();
    await light;
    assert.deepEqual(order, ["heavy", "light"]);
    limiter.stop();
  } finally {
    database.close();
  }
});

test("queued requests fail at the configured maximum wait", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    let now = NOW;
    const sleepers: Array<() => void> = [];
    const limiter = new WeightedRateLimiter({
      ratePerSecond: 1,
      capacity: 1,
      maximumQueueWaitMs: 500,
      repository: new PersistenceRepository(database),
      now: () => now,
      sleep: (milliseconds) =>
        new Promise<void>((resolve) => {
          sleepers.push(() => {
            now += milliseconds;
            resolve();
          });
        }),
    });
    await limiter.acquire(1, "realtime");
    const queued = limiter.acquire(1, "offline");
    await Promise.resolve();
    sleepers.shift()?.();
    await assert.rejects(queued, /queue timeout after 500ms/);
    assert.equal(limiter.getQueueSize(), 0);
    limiter.stop();
  } finally {
    database.close();
  }
});
