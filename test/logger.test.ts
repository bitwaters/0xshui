import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { createLogger } from "../src/logging/index.js";

test("structured logs redact secrets and truncate untrusted metadata", () => {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  const apiKey = "gmgn-super-secret";
  const botToken = ["123456789", "telegram-super-secret"].join(":");
  const logger = createLogger({
    level: "info",
    secrets: [apiKey, botToken],
    destination,
  });

  logger.info("config_loaded", {
    credentials: { gmgnApiKey: apiKey, telegramBotToken: botToken },
    attacker_metadata: `${"x".repeat(600)}${apiKey}`,
    query: { timestamp: 123, client_id: "uuid" },
  });
  logger.error("startup_failed", new Error(`request failed for ${apiKey}`));

  const output = chunks.join("");
  assert.doesNotMatch(output, new RegExp(apiKey));
  assert.doesNotMatch(output, new RegExp(botToken));
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /\[truncated\]/);
  assert.match(output, /"event":"config_loaded"/);
  assert.match(output, /"event":"startup_failed"/);
});

test("logger correlation children keep stable structured context", () => {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createLogger({ level: "info", destination });

  logger.withCorrelationId("correlation-test").info("app_started", { mode: "shadow" });

  const record = JSON.parse(chunks[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record.correlation_id, "correlation-test");
  assert.equal(record.event, "app_started");
  assert.equal(record.mode, "shadow");
});
