import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  configForSignalVersion,
  loadAppConfig,
  parseAppConfig,
} from "../src/config/index.js";

function rawDefaultConfig(): Record<string, unknown> {
  return parseYaml(readFileSync("config/default.yaml", "utf8")) as Record<string, unknown>;
}

test("loads and normalizes the documented default configuration", () => {
  const config = loadAppConfig();

  assert.equal(config.chain, "bsc");
  assert.equal(config.poll_interval, 1_000);
  assert.equal(config.gmgn.request_timeout, 5_000);
  assert.equal(config.gmgn.max_response_size, 10 * 1_024 * 1_024);
  assert.equal(config.gmgn.local_weight_limit_per_second, 4);
  assert.equal(config.rank.limit, 100);
  assert.deepEqual(config.rank.filters, ["not_honeypot"]);
  assert.equal(config.noise.creator_cooldown, 30 * 60_000);
  assert.deepEqual(config.outcomes.checkpoints, [15 * 60_000, 60 * 60_000]);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.gmgn));
});

test("keeps historical rank filters parseable for stored-config replay", () => {
  const raw = rawDefaultConfig();
  raw.rank = {
    ...(raw.rank as Record<string, unknown>),
    filters: ["not_honeypot", "verified", "renounced"],
  };

  assert.deepEqual(parseAppConfig(raw).rank.filters, [
    "not_honeypot",
    "verified",
    "renounced",
  ]);
});

test("signal configuration version ignores only delivery activation switches", () => {
  const base = loadAppConfig();
  const shadow = configForSignalVersion(base);
  const production = configForSignalVersion({
    ...base,
    mode: "production",
    telegram: { ...base.telegram, enabled: true },
  });
  assert.deepEqual(production, shadow);
  assert.notDeepEqual(
    configForSignalVersion({
      ...base,
      fast_rank_trigger: {
        ...base.fast_rank_trigger,
        max_rank_1m: base.fast_rank_trigger.max_rank_1m + 1,
      },
    }),
    shadow,
  );
});

test("supports only the explicit Telegram deployment override", () => {
  const enabled = loadAppConfig("config/default.yaml", { TELEGRAM_ENABLED: "true" });
  assert.equal(enabled.mode, "shadow");
  assert.equal(enabled.telegram.enabled, true);
  assert.throws(
    () => loadAppConfig("config/default.yaml", { TELEGRAM_ENABLED: "1" }),
    /TELEGRAM_ENABLED must be true or false/,
  );
});

test("rejects unsupported chains and unknown configuration keys", () => {
  const raw = rawDefaultConfig();
  raw.chain = "sol";
  raw.unexpected = true;

  assert.throws(() => parseAppConfig(raw));
});

test("requires production mode to enable Telegram", () => {
  const raw = rawDefaultConfig();
  raw.mode = "production";

  assert.throws(
    () => parseAppConfig(raw),
    /telegram\.enabled must be true in production mode/,
  );
});

test("rejects an invalid report time zone", () => {
  const raw = rawDefaultConfig();
  raw.report_timezone = "Mars/Olympus_Mons";

  assert.throws(() => parseAppConfig(raw), /valid IANA time zone/);
});

test("rejects inconsistent signal capacity and outcome checkpoints", () => {
  const raw = rawDefaultConfig();
  raw.noise = {
    ...(raw.noise as Record<string, unknown>),
    reserved_high_priority_slots: 2,
  };
  raw.outcomes = {
    ...(raw.outcomes as Record<string, unknown>),
    checkpoints: ["5m", "1h"],
  };

  assert.throws(() => parseAppConfig(raw));
});
