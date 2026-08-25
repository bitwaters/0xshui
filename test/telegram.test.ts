import assert from "node:assert/strict";
import test from "node:test";

import { GrammyError, HttpError, type InlineKeyboard } from "grammy";

import { openDatabase, PersistenceRepository, type SqliteDatabase } from "../src/db/index.js";
import {
  TelegramPublisher,
  buildSignalKeyboard,
  classifyTelegramFailure,
  createTelegramGateway,
  renderSignalCard,
  type SignalCardModel,
  type TelegramGateway,
} from "../src/telegram/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";

function card(overrides: Partial<SignalCardModel> = {}): SignalCardModel {
  return {
    tokenKey: TOKEN,
    name: "Signal Token",
    symbol: "SIG",
    lifecycle: "graduated",
    trigger: "fast_rank",
    moveClass: "normal",
    price: 0.001,
    marketCap: 100_000,
    rank1m: 5,
    rank5m: 20,
    confirmed: false,
    ...overrides,
  };
}

function setupQualified(): {
  readonly database: SqliteDatabase;
  readonly repository: PersistenceRepository;
} {
  const database = openDatabase({ path: ":memory:" });
  const repository = new PersistenceRepository(database);
  const configVersion = repository.registerConfigVersion({ test: true }, NOW);
  repository.upsertCandidateDecision({
    tokenKey: TOKEN,
    lifecycle: "graduated",
    state: "qualified",
    priority: "normal",
    configVersion,
    decision: { trigger: "fast_rank" },
    firstDiscoveredAt: NOW - 5_000,
    qualifiedAt: NOW - 1_000,
    securityCompletedAt: NOW - 500,
    now: NOW,
  });
  return { database, repository };
}

function gateway(overrides: Partial<TelegramGateway> = {}): TelegramGateway {
  return {
    sendMessage: async () => ({ message_id: 123 }),
    editMessageText: async () => true,
    ...overrides,
  };
}

function apiError(code: number, description = "failed", retryAfter?: number): GrammyError {
  return new GrammyError(
    "Telegram failed",
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
    },
    "sendMessage",
    {},
  );
}

test("signal cards escape hostile metadata, stay concise, and omit internal rules", () => {
  const rendered = renderSignalCard(
    card({
      name: `<b>${"x".repeat(5_000)}</b>&`,
      symbol: `</code><script>alert("x")</script>`,
      moveClass: "observation_only",
    }),
  );
  assert.ok(rendered.text.length < 3_500);
  assert.ok(rendered.text.includes("&lt;b&gt;"));
  assert.ok(rendered.text.includes("&lt;/code&gt;"));
  assert.ok(!rendered.text.includes("<script>"));
  assert.ok(!rendered.text.includes("0.30"));
  assert.ok(!rendered.text.includes("快照"));
  assert.ok(rendered.text.includes("仅作观察信号"));
});

test("keyboard uses only fixed GMGN, BscScan, and copy-contract actions", () => {
  const keyboard = buildSignalKeyboard(TOKEN).inline_keyboard;
  assert.deepEqual(keyboard, [
    [
      { text: "GMGN", url: `https://gmgn.ai/bsc/token/${TOKEN}` },
      { text: "BscScan", url: `https://bscscan.com/token/${TOKEN}` },
    ],
    [{ text: "复制合约", copy_text: { text: TOKEN } }],
  ]);
  assert.throws(() => buildSignalKeyboard("not-an-address"));
  const directGateway = createTelegramGateway("123:test-token");
  assert.equal(typeof directGateway.sendMessage, "function");
  assert.throws(() => createTelegramGateway("   "));
});

test("Telegram error classification separates definitive API rejection from ambiguity", () => {
  assert.deepEqual(classifyTelegramFailure(apiError(429, "rate", 99)), {
    acceptance: "definitively_not_accepted",
    retryable: true,
    reason: "telegram_api_429",
    retryAfterMs: 30_000,
  });
  assert.deepEqual(classifyTelegramFailure(apiError(400)), {
    acceptance: "definitively_not_accepted",
    retryable: false,
    reason: "telegram_api_400",
    retryAfterMs: 0,
  });
  assert.equal(
    classifyTelegramFailure(new HttpError("network failed", new Error("socket"))).acceptance,
    "ambiguous",
  );
});

test("concurrent triggers have one atomic delivery winner", async () => {
  const { database, repository } = setupQualified();
  try {
    let sends = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          sends += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { message_id: 321 };
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW,
    });
    const request = { recheck: async () => ({ ok: true as const, card: card() }), tokenKey: TOKEN };
    const results = await Promise.all([publisher.publish(request), publisher.publish(request)]);
    assert.equal(sends, 1);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["duplicate", "sent"],
    );
    assert.deepEqual(repository.getDeliveryTarget(TOKEN), {
      state: "sent",
      telegramMessageId: 321,
      attempts: 1,
    });
  } finally {
    database.close();
  }
});

test("ambiguous HTTP delivery is never retried and remains delivery_unknown after restart", async () => {
  const { database, repository } = setupQualified();
  try {
    let calls = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          calls += 1;
          throw new HttpError("response lost", new Error("socket closed"));
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW,
    });
    const result = await publisher.publish({
      tokenKey: TOKEN,
      recheck: async () => ({ ok: true, card: card() }),
    });
    assert.equal(result.status, "delivery_unknown");
    assert.equal(calls, 1);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "delivery_unknown");
    assert.equal(
      (
        await publisher.publish({
          tokenKey: TOKEN,
          recheck: async () => ({ ok: true, card: card() }),
        })
      ).status,
      "duplicate",
    );
  } finally {
    database.close();
  }
});

test("definitive retryable failures retry at most three total attempts", async () => {
  const { database, repository } = setupQualified();
  try {
    let calls = 0;
    const sleeps: number[] = [];
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          calls += 1;
          if (calls < 3) {
            throw apiError(500);
          }
          return { message_id: 456 };
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    const result = await publisher.publish({
      tokenKey: TOKEN,
      recheck: async () => ({ ok: true, card: card() }),
    });
    assert.deepEqual(result, { status: "sent", attempts: 3, messageId: 456 });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [250, 500]);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.attempts, 3);
  } finally {
    database.close();
  }
});

test("persisted attempts survive retry release and cap later publisher runs", async () => {
  const { database, repository } = setupQualified();
  try {
    assert.equal(repository.tryMarkDeliveryPending(TOKEN, NOW), true);
    assert.equal(repository.releaseDeliveryForRetry(TOKEN, "prior_failure", NOW), true);
    let calls = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          calls += 1;
          throw apiError(500);
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW,
      sleep: async () => undefined,
    });
    const result = await publisher.publish({
      tokenKey: TOKEN,
      recheck: async () => ({ ok: true, card: card() }),
    });
    assert.equal(result.status, "not_sent");
    assert.equal(result.attempts, 3);
    assert.equal(calls, 2);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "cancelled");
  } finally {
    database.close();
  }
});

test("a candidate that fades before a safe retry is cancelled instead of resent", async () => {
  const { database, repository } = setupQualified();
  try {
    let sends = 0;
    let checks = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          sends += 1;
          throw apiError(500);
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW,
      sleep: async () => undefined,
    });
    const result = await publisher.publish({
      tokenKey: TOKEN,
      recheck: async () => {
        checks += 1;
        return checks === 1
          ? { ok: true, card: card() }
          : { ok: false, reason: "rank_fallback" };
      },
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.reason, "telegram_delay_cancelled:rank_fallback");
    assert.equal(sends, 1);
    assert.equal(checks, 2);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "cancelled");
  } finally {
    database.close();
  }
});

test("permanent rejection and delayed-market cancellation do not retry", async () => {
  const permanent = setupQualified();
  try {
    let calls = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          calls += 1;
          throw apiError(400);
        },
      }),
      repository: permanent.repository,
      chatId: "-1001",
      now: () => NOW,
    });
    assert.equal(
      (
        await publisher.publish({
          tokenKey: TOKEN,
          recheck: async () => ({ ok: true, card: card() }),
        })
      ).status,
      "not_sent",
    );
    assert.equal(calls, 1);
  } finally {
    permanent.database.close();
  }

  const delayed = setupQualified();
  try {
    let calls = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          calls += 1;
          return { message_id: 1 };
        },
      }),
      repository: delayed.repository,
      chatId: "-1001",
      now: () => NOW,
    });
    const result = await publisher.publish({
      tokenKey: TOKEN,
      recheck: async () => ({ ok: false, reason: "rank_fallback" }),
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.reason, "telegram_delay_cancelled:rank_fallback");
    assert.equal(calls, 0);
    assert.equal(delayed.repository.getDeliveryTarget(TOKEN)?.state, "cancelled");
  } finally {
    delayed.database.close();
  }
});

test("mismatched or invalid refreshed cards cancel before Telegram is called", async () => {
  for (const invalidCard of [
    card({ tokenKey: "0x2222222222222222222222222222222222222222" }),
    card({ price: Number.NaN }),
  ]) {
    const { database, repository } = setupQualified();
    try {
      let calls = 0;
      const publisher = new TelegramPublisher({
        api: gateway({
          sendMessage: async () => {
            calls += 1;
            return { message_id: 1 };
          },
        }),
        repository,
        chatId: "-1001",
        now: () => NOW,
      });
      const result = await publisher.publish({
        tokenKey: TOKEN,
        recheck: async () => ({ ok: true, card: invalidCard }),
      });
      assert.equal(result.status, "cancelled");
      assert.equal(calls, 0);
      assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "cancelled");
    } finally {
      database.close();
    }
  }
});

test("confirmation edits the original message and tolerates an already-applied edit", async () => {
  const { database, repository } = setupQualified();
  try {
    assert.equal(repository.tryMarkDeliveryPending(TOKEN, NOW), true);
    assert.equal(repository.markSent(TOKEN, 777, NOW), true);
    const edits: Array<{ messageId: number; text: string; keyboard: InlineKeyboard }> = [];
    const publisher = new TelegramPublisher({
      api: gateway({
        editMessageText: async (_chatId, messageId, text, options) => {
          edits.push({ messageId, text, keyboard: options.reply_markup });
          return true;
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW + 1,
    });
    assert.equal(await publisher.confirm(TOKEN, card()), true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.messageId, 777);
    assert.ok(edits[0]?.text.includes("趋势确认"));
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "confirmed");
  } finally {
    database.close();
  }

  const replay = setupQualified();
  try {
    replay.repository.tryMarkDeliveryPending(TOKEN, NOW);
    replay.repository.markSent(TOKEN, 778, NOW);
    const publisher = new TelegramPublisher({
      api: gateway({
        editMessageText: async () => {
          throw apiError(400, "Bad Request: message is not modified");
        },
      }),
      repository: replay.repository,
      chatId: "-1001",
      now: () => NOW + 1,
    });
    assert.equal(await publisher.confirm(TOKEN, card()), true);
    assert.equal(replay.repository.getDeliveryTarget(TOKEN)?.state, "confirmed");
  } finally {
    replay.database.close();
  }
});

test("a storage failure after Telegram acceptance becomes ambiguous without resend", async () => {
  const { database, repository } = setupQualified();
  try {
    database.exec(`
      CREATE TRIGGER reject_sent
      BEFORE UPDATE OF state ON signals
      WHEN NEW.state = 'sent'
      BEGIN
        SELECT RAISE(FAIL, 'forced sent persistence failure');
      END
    `);
    let sends = 0;
    const publisher = new TelegramPublisher({
      api: gateway({
        sendMessage: async () => {
          sends += 1;
          return { message_id: 999 };
        },
      }),
      repository,
      chatId: "-1001",
      now: () => NOW,
    });
    const result = await publisher.publish({
      tokenKey: TOKEN,
      recheck: async () => ({ ok: true, card: card() }),
    });
    assert.equal(result.status, "delivery_unknown");
    assert.equal(sends, 1);
    assert.equal(repository.getDeliveryTarget(TOKEN)?.state, "delivery_unknown");
  } finally {
    database.close();
  }
});
