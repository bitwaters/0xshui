import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeScheduler, type SourcePoller } from "../src/realtime/index.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("scheduler skips only an overlapping source and continues the other sources", async () => {
  const slow = deferred<{ value: string; sourceCapturedAt: number }>();
  const calls = { trenches: 0, rank_1m: 0, rank_5m: 0 };
  const overlaps: string[] = [];
  const poller = (source: keyof typeof calls): SourcePoller => ({
    poll: async () => {
      calls[source] += 1;
      if (source === "trenches" && calls[source] === 1) {
        return slow.promise;
      }
      return { value: source, sourceCapturedAt: calls[source] };
    },
    onSuccess: () => undefined,
    onOverlap: (name) => overlaps.push(name),
  });
  const scheduler = new RealtimeScheduler({
    intervalMs: 1_000,
    sources: {
      trenches: poller("trenches"),
      rank_1m: poller("rank_1m"),
      rank_5m: poller("rank_5m"),
    },
  });

  await scheduler.tick();
  await flush();
  await scheduler.tick();
  await flush();
  assert.deepEqual(calls, { trenches: 1, rank_1m: 2, rank_5m: 2 });
  assert.deepEqual(overlaps, ["trenches"]);

  slow.resolve({ value: "trenches", sourceCapturedAt: 1 });
  await scheduler.waitForIdle();
});

test("one source failure does not prevent successful peers", async () => {
  const successes: string[] = [];
  const failures: string[] = [];
  const source = (name: string, fail = false): SourcePoller => ({
    poll: async () => {
      if (fail) {
        throw new Error("source failed");
      }
      return { value: name, sourceCapturedAt: 1 };
    },
    onSuccess: (pollSource) => {
      successes.push(pollSource);
    },
    onFailure: (pollSource) => {
      failures.push(pollSource);
    },
  });
  const scheduler = new RealtimeScheduler({
    intervalMs: 1_000,
    sources: {
      trenches: source("trenches", true),
      rank_1m: source("rank_1m"),
      rank_5m: source("rank_5m"),
    },
  });
  await scheduler.tick();
  await scheduler.waitForIdle();
  assert.deepEqual(successes.sort(), ["rank_1m", "rank_5m"]);
  assert.deepEqual(failures, ["trenches"]);
});
