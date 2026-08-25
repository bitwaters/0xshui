import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { openDatabase, PersistenceRepository } from "../src/db/index.js";
import { GmgnHttpClient, unwrapSuccessEnvelope } from "../src/gmgn/index.js";
import { SecurityManager, TokenWindowStore } from "../src/realtime/index.js";

const NOW = 1_787_614_000_000;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";

function securityPayload(address: string): Record<string, unknown> {
  const fixture = JSON.parse(
    readFileSync("test/fixtures/gmgn/security-single.json", "utf8"),
  ) as unknown;
  return {
    ...(unwrapSuccessEnvelope(fixture).data as Record<string, unknown>),
    address,
  };
}

function response(address: string): Response {
  return new Response(JSON.stringify({ code: 0, data: securityPayload(address) }), {
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Security queue is candidate-scoped, concurrency-bounded, cached, and send-fresh", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    let now = NOW;
    const started: string[] = [];
    const resolvers = new Map<string, (value: Response) => void>();
    const client = new GmgnHttpClient({
      apiKey: "test",
      baseUrl: "https://openapi.gmgn.ai",
      userAgent: "test",
      timeoutMs: 5_000,
      maxResponseBytes: 10_000,
      now: () => now,
      fetchImplementation: async (input) => {
        const address = new URL(String(input)).searchParams.get("address") ?? "";
        started.push(address);
        return new Promise<Response>((resolve) => resolvers.set(address, resolve));
      },
    });
    const manager = new SecurityManager({
      client,
      repository,
      windowStore: new TokenWindowStore(),
      concurrency: 1,
      cacheTtlMs: 60_000,
      sendMaximumAgeMs: 10_000,
      now: () => now,
    });

    const first = manager.preheat(A);
    const queued = manager.preheat(B);
    const urgent = manager.getFreshForSend(C);
    await flush();
    assert.deepEqual(started, [A]);
    assert.equal(manager.getActiveCount(), 1);
    assert.equal(manager.getQueueSize(), 2);

    resolvers.get(A)?.(response(A));
    assert.equal((await first)?.address, A);
    await flush();
    assert.deepEqual(started, [A, C], "send refresh must move ahead of ordinary preheat");

    resolvers.get(C)?.(response(C));
    assert.equal((await urgent)?.address, C);
    await flush();
    assert.deepEqual(started, [A, C, B]);
    resolvers.get(B)?.(response(B));
    assert.equal((await queued)?.address, B);
    await flush();

    assert.equal((await manager.preheat(A))?.address, A);
    assert.deepEqual(started, [A, C, B], "60-second preheat cache should avoid a request");

    now += 11_000;
    const refresh = manager.getFreshForSend(A);
    await flush();
    assert.deepEqual(started, [A, C, B, A]);
    resolvers.get(A)?.(response(A));
    assert.equal((await refresh)?.address, A);

    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM security_checks").get() as { count: number })
        .count,
      4,
    );
  } finally {
    database.close();
  }
});

test("Security contract failure is persisted as failed and never cached", async () => {
  const database = openDatabase({ path: ":memory:" });
  try {
    const repository = new PersistenceRepository(database);
    let calls = 0;
    const client = new GmgnHttpClient({
      apiKey: "test",
      baseUrl: "https://openapi.gmgn.ai",
      userAgent: "test",
      timeoutMs: 5_000,
      maxResponseBytes: 10_000,
      now: () => NOW,
      fetchImplementation: async () => {
        calls += 1;
        return new Response(JSON.stringify({ code: 0, data: { address: "" } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const manager = new SecurityManager({
      client,
      repository,
      windowStore: new TokenWindowStore(),
      concurrency: 3,
      cacheTtlMs: 60_000,
      sendMaximumAgeMs: 10_000,
      now: () => NOW,
    });

    assert.equal(await manager.getFreshForSend(D), null);
    assert.equal(manager.getCached(D), null);
    assert.equal(await manager.preheat(D), null);
    assert.equal(calls, 2, "failed Security results must not enter cache");
    const statuses = database
      .prepare("SELECT status FROM security_checks ORDER BY ingest_seq")
      .all();
    assert.deepEqual(statuses, [{ status: "failed" }, { status: "failed" }]);
  } finally {
    database.close();
  }
});
