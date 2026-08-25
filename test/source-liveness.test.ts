import assert from "node:assert/strict";
import test from "node:test";

import { SourceLivenessWatchdog } from "../src/realtime/index.js";

const NOW = 1_787_614_000_000;

test("source watchdog grants startup grace and reports every stale required source", () => {
  const watchdog = new SourceLivenessWatchdog({ startedAt: NOW, timeoutMs: 30_000 });
  assert.deepEqual(watchdog.staleSources(NOW + 29_999), []);
  assert.deepEqual(watchdog.staleSources(NOW + 30_000), ["trenches", "rank_1m", "rank_5m"]);
});

test("every successful response refreshes source liveness even without changed rows", () => {
  const watchdog = new SourceLivenessWatchdog({ startedAt: NOW, timeoutMs: 30_000 });
  watchdog.markSuccess("trenches", NOW + 20_000);
  watchdog.markSuccess("rank_1m", NOW + 20_000);
  watchdog.markSuccess("rank_5m", NOW + 20_000);
  assert.deepEqual(watchdog.staleSources(NOW + 49_999), []);
  assert.deepEqual(watchdog.staleSources(NOW + 50_000), ["trenches", "rank_1m", "rank_5m"]);
});

test("a current source does not hide another stale source", () => {
  const watchdog = new SourceLivenessWatchdog({ startedAt: NOW, timeoutMs: 30_000 });
  watchdog.markSuccess("trenches", NOW + 29_000);
  watchdog.markSuccess("rank_1m", NOW + 29_000);
  assert.deepEqual(watchdog.staleSources(NOW + 30_000), ["rank_5m"]);
});
