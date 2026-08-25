import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GmgnHttpClient, runGmgnSelfCheck } from "../src/gmgn/index.js";

const NOW = 1_787_614_000_000;

function rankFixture(): unknown {
  return JSON.parse(readFileSync("test/fixtures/gmgn/rank-double.json", "utf8")) as unknown;
}

function makeClient(body: unknown, date: string | null): GmgnHttpClient {
  return new GmgnHttpClient({
    apiKey: "test",
    baseUrl: "https://openapi.gmgn.ai",
    userAgent: "test",
    timeoutMs: 5_000,
    maxResponseBytes: 10_000,
    now: () => NOW,
    uuid: () => "00000000-0000-4000-8000-000000000001",
    sleep: async () => undefined,
    fetchImplementation: async () =>
      new Response(JSON.stringify(body), {
        headers: {
          "content-type": "application/json",
          ...(date === null ? {} : { date }),
        },
      }),
  });
}

test("self-check accepts valid Schema/Auth and a missing Date header", async () => {
  const result = await runGmgnSelfCheck(makeClient(rankFixture(), null), () => NOW);
  assert.deepEqual(result, {
    ok: true,
    formalDeliveryAllowed: true,
    clockDriftMs: null,
  });
});

test("self-check blocks formal delivery on clock drift or schema failure", async () => {
  const drifted = await runGmgnSelfCheck(
    makeClient(rankFixture(), new Date(NOW - 60_000).toUTCString()),
    () => NOW,
  );
  assert.equal(drifted.reason, "clock_drift");
  assert.equal(drifted.formalDeliveryAllowed, false);

  const malformed = await runGmgnSelfCheck(
    makeClient({ code: 0, data: { rank: [{ address: "bad" }] } }, null),
    () => NOW,
  );
  assert.equal(malformed.reason, "auth_or_schema");
  assert.equal(malformed.formalDeliveryAllowed, false);

  const empty = await runGmgnSelfCheck(
    makeClient({ code: 0, data: { rank: [] } }, null),
    () => NOW,
  );
  assert.equal(empty.reason, "auth_or_schema");
});
