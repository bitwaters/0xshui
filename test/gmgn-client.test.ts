import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GmgnApiError,
  GmgnContractError,
  GmgnError,
  GmgnHttpClient,
  GmgnRateLimitError,
  unwrapSuccessEnvelope,
} from "../src/gmgn/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`test/fixtures/gmgn/${name}`, "utf8")) as unknown;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function client(
  fetchImplementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof GmgnHttpClient>[0]> = {},
): GmgnHttpClient {
  let uuidCounter = 0;
  return new GmgnHttpClient({
    apiKey: "test-api-key",
    baseUrl: "https://openapi.gmgn.ai",
    userAgent: "gmgn-bsc-signal-bot/test",
    timeoutMs: 5_000,
    maxResponseBytes: 10 * 1_024 * 1_024,
    now: () => NOW,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    sleep: async () => undefined,
    random: () => 0,
    fetchImplementation,
    ...overrides,
  });
}

test("serializes all five BSC read-only requests with fresh Exist Auth", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const gmgn = client(async (input, init = {}) => {
    requests.push({ url: new URL(String(input)), init });
    return jsonResponse({ code: 0, data: {} });
  });

  await gmgn.fetchTrenches();
  await gmgn.fetchRank("1m");
  await gmgn.fetchSecurity(TOKEN);
  await gmgn.fetchKline(TOKEN, 1_787_610_000, 1_787_614_000);
  await gmgn.fetchPool(TOKEN);

  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    [
      "/v1/trenches",
      "/v1/market/rank",
      "/v1/token/security",
      "/v1/market/token_kline",
      "/v1/token/pool_info",
    ],
  );
  assert.equal(new Set(requests.map(({ url }) => url.searchParams.get("client_id"))).size, 5);
  for (const { url, init } of requests) {
    assert.equal(url.searchParams.get("chain"), "bsc");
    assert.equal(url.searchParams.get("timestamp"), String(NOW / 1_000));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-apikey"), "test-api-key");
    assert.equal(headers.get("user-agent"), "gmgn-bsc-signal-bot/test");
    assert.equal(headers.has("x-signature"), false);
  }

  const trenchesBody = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  assert.equal(trenchesBody.version, "v2");
  for (const stage of ["new_creation", "near_completion", "completed"]) {
    const section = trenchesBody[stage] as Record<string, unknown>;
    assert.equal(section.limit, 80);
    assert.equal(section.max_rug_ratio, 0.3);
    assert.equal(section.max_bundler_rate, 0.3);
    assert.equal(section.max_insider_ratio, 0.3);
  }
  const rankUrl = requests[1]?.url;
  assert.equal(rankUrl?.searchParams.get("limit"), "100");
  assert.deepEqual(rankUrl?.searchParams.getAll("filters"), [
    "not_honeypot",
    "verified",
    "renounced",
  ]);
  assert.equal(requests[3]?.url.searchParams.get("resolution"), "30s");
});

test("retries one network or 5xx failure with new auth and bounded jitter", async () => {
  const clientIds: string[] = [];
  const sleeps: number[] = [];
  const metrics: Array<{ path: string; durationMs: number; success: boolean }> = [];
  let clock = NOW;
  let attempts = 0;
  const gmgn = client(
    async (input) => {
      attempts += 1;
      clientIds.push(new URL(String(input)).searchParams.get("client_id") ?? "");
      if (attempts === 1) {
        clock += 25;
        return new Response("temporary", { status: 503 });
      }
      clock += 10;
      return jsonResponse({ code: 0, data: { rank: [] } });
    },
    {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      random: () => 0.5,
      now: () => clock,
      onAttemptCompleted: (metric) => metrics.push(metric),
    },
  );

  await gmgn.fetchRank("5m");
  assert.equal(attempts, 2);
  assert.notEqual(clientIds[0], clientIds[1]);
  assert.deepEqual(sleeps, [350]);
  assert.deepEqual(metrics, [
    { path: "/v1/market/rank", durationMs: 25, success: false },
    { path: "/v1/market/rank", durationMs: 10, success: true },
  ]);
});

test("429 fails without retry and prefers valid header reset metadata", async () => {
  let attempts = 0;
  const gmgn = client(async () => {
    attempts += 1;
    return jsonResponse(fixture("rate-limit.json"), {
      status: 429,
      headers: { "x-ratelimit-reset": String(NOW / 1_000 + 120) },
    });
  });

  await assert.rejects(
    gmgn.fetchRank("1m"),
    (error: unknown) => {
      assert.ok(error instanceof GmgnRateLimitError);
      assert.equal(error.cooldownUntil, NOW + 121_000);
      assert.equal(error.source, "header");
      return true;
    },
  );
  assert.equal(attempts, 1);

  const oversized = client(
    async () =>
      jsonResponse(fixture("rate-limit.json"), {
        status: 429,
        headers: {
          "x-ratelimit-reset": String(NOW / 1_000 + 90),
          "content-length": "1000",
        },
      }),
    { maxResponseBytes: 10 },
  );
  await assert.rejects(
    oversized.fetchRank("1m"),
    (error: unknown) =>
      error instanceof GmgnRateLimitError && error.cooldownUntil === NOW + 91_000,
  );
});

test("recognizes nested rate limits and uses the safe fallback for non-JSON 429", async () => {
  const nested = client(async () =>
    jsonResponse({
      code: 0,
      data: { code: 429, error: "RATE_LIMIT_BANNED", reset_at: NOW / 1_000 + 60 },
    }),
  );
  await assert.rejects(
    nested.fetchRank("1m"),
    (error: unknown) =>
      error instanceof GmgnRateLimitError &&
      error.source === "body" &&
      error.cooldownUntil === NOW + 61_000,
  );

  const fallback = client(async () => new Response("busy", { status: 429 }));
  await assert.rejects(
    fallback.fetchRank("1m"),
    (error: unknown) =>
      error instanceof GmgnRateLimitError &&
      error.source === "fallback" &&
      error.cooldownUntil === NOW + 300_000,
  );
});

test("the hard timeout covers response body download, not only response headers", async () => {
  const gmgn = client(
    async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    { timeoutMs: 5 },
  );
  await assert.rejects(
    gmgn.fetchRank("1m"),
    (error: unknown) => error instanceof GmgnError && error.kind === "timeout",
  );
});

test("enforces response size, content type, HTTP, and envelope contracts", async () => {
  const oversized = client(
    async () =>
      jsonResponse({ code: 0, data: {} }, { headers: { "content-length": "101" } }),
    { maxResponseBytes: 100 },
  );
  await assert.rejects(
    oversized.fetchRank("1m"),
    (error: unknown) => error instanceof GmgnError && error.kind === "response_too_large",
  );

  const html = client(async () =>
    new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  await assert.rejects(
    html.fetchRank("1m"),
    (error: unknown) => error instanceof GmgnError && error.kind === "invalid_json",
  );

  assert.deepEqual(unwrapSuccessEnvelope({ code: 0, data: { value: 1 } }), {
    data: { value: 1 },
    depth: 1,
  });
  assert.deepEqual(
    unwrapSuccessEnvelope({ code: 0, data: { code: 0, data: { value: 2 } } }),
    { data: { value: 2 }, depth: 2 },
  );
  assert.throws(
    () =>
      unwrapSuccessEnvelope({
        code: 0,
        data: { code: 0, data: { code: 0, data: { value: 3 } } },
      }),
    GmgnContractError,
  );
  assert.throws(() => unwrapSuccessEnvelope({ code: 500, data: null }), GmgnApiError);
  assert.throws(() => unwrapSuccessEnvelope({ code: 400, error: "BAD_REQUEST" }), GmgnApiError);
});

test("rejects bad addresses and invalid Kline ranges before network access", async () => {
  const gmgn = client(async () => {
    throw new Error("network must not be called");
  });
  assert.throws(() => gmgn.fetchSecurity("not-an-address"), GmgnContractError);
  assert.throws(() => gmgn.fetchKline(TOKEN, 10, 10), RangeError);
});
