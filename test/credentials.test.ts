import assert from "node:assert/strict";
import test from "node:test";

import { loadAppConfig, loadRuntimeCredentials, parseAppConfig } from "../src/config/index.js";

test("shadow mode without Telegram only requires the GMGN API key", () => {
  const config = loadAppConfig();
  const credentials = loadRuntimeCredentials(config, {
    GMGN_API_KEY: "gmgn-test-key",
  });

  assert.equal(credentials.gmgnApiKey, "gmgn-test-key");
  assert.equal(credentials.telegram, null);
});

test("credential errors identify variables without including their values", () => {
  const config = loadAppConfig();
  const secret = "should-never-appear";

  assert.throws(
    () => loadRuntimeCredentials(config, { GMGN_API_KEY: `   `, UNUSED_SECRET: secret }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /GMGN_API_KEY/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("Telegram-enabled mode requires valid Telegram credentials", () => {
  const base = loadAppConfig();
  const config = parseAppConfig({
    ...base,
    mode: "production",
    telegram: { enabled: true, daily_report: true },
  });

  assert.throws(
    () =>
      loadRuntimeCredentials(config, {
        GMGN_API_KEY: "gmgn-test-key",
        TELEGRAM_BOT_TOKEN: "invalid",
        TELEGRAM_CHAT_ID: "invalid chat id",
      }),
    /TELEGRAM_BOT_TOKEN/,
  );

  const credentials = loadRuntimeCredentials(config, {
    GMGN_API_KEY: "gmgn-test-key",
    TELEGRAM_BOT_TOKEN: ["123456789", "abcdefghijklmnopqrstuvwxyz_ABCD"].join(":"),
    TELEGRAM_CHAT_ID: "-1001234567890",
  });
  assert.equal(credentials.telegram?.chatId, "-1001234567890");
});
