import assert from "node:assert/strict";
import test from "node:test";

import { loadAppConfig } from "../src/config/index.js";
import {
  DETECTOR_VERSION,
  canTransitionSignalState,
  classifyMove,
  detectMatureTrigger,
  detectTrigger,
  evaluateDetector,
  evaluateSafety,
  passesResearchSafety,
  selectWithinNoiseLimits,
  shouldPreheatSecurity,
  type CandidateReference,
  type DetectorInput,
  type Observation,
} from "../src/detection/index.js";
import type { RankToken, SecuritySnapshot, TrenchesToken } from "../src/gmgn/index.js";

const NOW = 1_787_614_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const OTHER_CREATOR = "0x3333333333333333333333333333333333333333";
const config = loadAppConfig();

function rank(overrides: Partial<RankToken> = {}): RankToken {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    interval: "1m",
    rank: 25,
    price: 1,
    marketCap: 100_000,
    liquidity: 20_000,
    swaps: 100,
    buys: 70,
    sells: 30,
    holderCount: 100,
    smartDegenCount: 0,
    creatorAddress: CREATOR,
    ...overrides,
  };
}

function trench(overrides: Partial<TrenchesToken> = {}): TrenchesToken {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    stage: "new_creation",
    price: 1,
    marketCap: 100_000,
    holderCount: 20,
    curveSwapsTotal: 20,
    curveNetBuyTotal: 10,
    bondingProgress: 0.2,
    smartDegenCount: 0,
    bundlerRate: 0.1,
    insiderRate: 0.1,
    devTeamHoldRate: 0.1,
    creatorBalanceRate: 0.1,
    creatorAddress: CREATOR,
    ...overrides,
  };
}

function security(overrides: Partial<SecuritySnapshot> = {}): SecuritySnapshot {
  return {
    tokenKey: TOKEN,
    address: TOKEN,
    isHoneypot: false,
    isOpenSource: true,
    isOwnerRenounced: true,
    buyTax: 0.05,
    sellTax: 0.05,
    top10HolderRate: 0.4,
    lockPercent: 0.8,
    conflicts: [],
    ...overrides,
  };
}

function observation<T>(capturedAt: number, value: T | null): Observation<T> {
  return { capturedAt, value };
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function input(overrides: Partial<DetectorInput> = {}): DetectorInput {
  return {
    version: DETECTOR_VERSION,
    tokenKey: TOKEN,
    now: NOW,
    configVersion: 1,
    config,
    state: "observing",
    discovery: { discoveredAt: NOW - 20_000, price: 1, marketCap: 100_000 },
    market: {
      trenches: [],
      rank1m: [],
      rank5m: [],
      sourceFresh: { trenches: false, rank_1m: false, rank_5m: false },
    },
    ...overrides,
  };
}

test("curve acceleration qualifies at exact boundaries and cumulative resets do not trigger", () => {
  const baseline = trench({
    holderCount: 17,
    curveSwapsTotal: 10,
    curveNetBuyTotal: 5,
    bondingProgress: 0.18,
  });
  const current = trench();
  const qualifying = input({
    market: {
      trenches: [observation(NOW - 10_000, baseline), observation(NOW, current)],
      rank1m: [],
      rank5m: [],
      sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
    },
    security: { capturedAt: NOW, value: security() },
  });
  const decision = evaluateDetector(qualifying);
  assert.equal(decision.action, "qualified");
  assert.equal(decision.evidence?.trigger, "curve_acceleration");
  assert.equal(decision.evidence?.lifecycle, "curve");

  const reset = input({
    market: {
      trenches: [
        observation(NOW - 5_000, trench({ curveSwapsTotal: 30, curveNetBuyTotal: 15 })),
        observation(NOW, trench({ curveSwapsTotal: 20, curveNetBuyTotal: 10 })),
      ],
      rank1m: [],
      rank5m: [],
      sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
    },
  });
  assert.equal(detectTrigger(reset), null);
});

test("fast-rank requires holder growth plus Trenches presence or smart-money growth", () => {
  const baseMarket = {
    trenches: [],
    rank1m: [
      observation(NOW - 5_000, rank({ rank: 25, holderCount: 100, smartDegenCount: 0 })),
      observation(NOW, rank({ rank: 10, holderCount: 103, smartDegenCount: 1 })),
    ],
    rank5m: [],
    sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
  } as const;
  const decision = evaluateDetector(
    input({ market: baseMarket, security: { capturedAt: NOW, value: security() } }),
  );
  assert.equal(decision.action, "qualified");
  assert.equal(decision.evidence?.trigger, "fast_rank");

  const noHolderGrowth = input({
    market: {
      ...baseMarket,
      rank1m: [
        observation(NOW - 5_000, rank({ rank: 25, holderCount: 100, smartDegenCount: 0 })),
        observation(NOW, rank({ rank: 10, holderCount: 102, smartDegenCount: 1 })),
      ],
    },
  });
  assert.notEqual(detectTrigger(noHolderGrowth)?.trigger, "fast_rank");
});

test("cross-source path accepts exact rank and participation boundaries", () => {
  const rank5 = rank({ interval: "5m", rank: 80 });
  const candidate = input({
    market: {
      trenches: [],
      rank1m: [
        observation(NOW - 5_000, rank({ rank: 40, holderCount: 100, swaps: 100 })),
        observation(NOW, rank({ rank: 30, holderCount: 103, swaps: 100 })),
      ],
      rank5m: [observation(NOW - 20_000, rank5)],
      sourceFresh: { trenches: false, rank_1m: true, rank_5m: true },
    },
  });
  assert.equal(detectTrigger(candidate)?.trigger, "cross_source");
});

test("cross-source uses authoritative current 5m presence without fake momentum", () => {
  const currentRank5 = rank({ interval: "5m", rank: 40 });
  const candidate = input({
    market: {
      trenches: [],
      rank1m: [
        observation(NOW - 5_000, rank({ rank: 25, holderCount: 100, swaps: 100 })),
        observation(NOW, rank({ rank: 20, holderCount: 103, swaps: 100 })),
      ],
      rank5m: [],
      current: { rank1m: rank({ rank: 20, holderCount: 103 }), rank5m: currentRank5 },
      sourceFresh: { trenches: false, rank_1m: true, rank_5m: true },
    },
  });
  assert.equal(detectTrigger(candidate)?.trigger, "cross_source");

  assert.equal(
    detectTrigger(
      input({
        market: {
          trenches: [],
          rank1m: [observation(NOW, rank({ rank: 5 }))],
          rank5m: [],
          current: { rank1m: rank({ rank: 5 }), rank5m: currentRank5 },
          sourceFresh: { trenches: false, rank_1m: true, rank_5m: true },
        },
      }),
    ),
    null,
    "current state alone must not create a rank-improvement event",
  );
});

test("mature momentum is age and liquidity gated and remains shadow-only by default", () => {
  const oldRank1 = rank({
    rank: 20,
    liquidity: 30_000,
    creationTimestampMs: NOW - 2 * 60 * 60_000,
  });
  const oldRank5 = rank({
    interval: "5m",
    rank: 40,
    liquidity: 30_000,
    creationTimestampMs: NOW - 2 * 60 * 60_000,
  });
  const market = {
    trenches: [],
    rank1m: [
      observation(NOW - 30_000, { ...oldRank1, rank: 23 }),
      observation(NOW, oldRank1),
    ],
    rank5m: [],
    current: { rank1m: oldRank1, rank5m: oldRank5 },
    sourceFresh: { trenches: false, rank_1m: true, rank_5m: true },
  } as const;
  const shadow = input({ market, security: { capturedAt: NOW, value: security() } });
  assert.equal(detectMatureTrigger(shadow)?.trigger, "mature_momentum");
  assert.equal(detectTrigger(shadow), null);

  const live = input({
    market,
    config: {
      ...config,
      mature_momentum: { ...config.mature_momentum, live_delivery: true },
    },
    security: { capturedAt: NOW, value: security() },
  });
  assert.equal(evaluateDetector(live).evidence?.trigger, "mature_momentum");
  assert.equal(
    detectMatureTrigger(
      input({
        market: {
          ...market,
          current: { rank1m: { ...oldRank1, liquidity: 29_999 }, rank5m: oldRank5 },
        },
      }),
    ),
    null,
  );
});

test("Security hard thresholds pass at equality and reject immediately above", () => {
  const exactSource = trench({
    rugRatio: 0.3,
    bundlerRate: 0.3,
    insiderRate: 0.3,
    ratTraderRate: 0.3,
    entrapmentRatio: 0.3,
    devTeamHoldRate: 0.15,
    creatorBalanceRate: 0.15,
  });
  const exact = evaluateSafety({
    lifecycle: "curve",
    security: security({ buyTax: 0.1, sellTax: 0.1, top10HolderRate: 0.5 }),
    sources: [exactSource],
    curveSource: exactSource,
    hasSafeTrenches: true,
    config: config.risk_filters,
  });
  assert.equal(exact.status, "pass");

  const cases: readonly [Partial<SecuritySnapshot>, Partial<TrenchesToken>, string][] = [
    [{ isHoneypot: true }, {}, "honeypot"],
    [{ buyTax: 0.100_001 }, {}, "buy_tax"],
    [{ sellTax: 0.100_001 }, {}, "sell_tax"],
    [{ top10HolderRate: 0.500_001 }, {}, "top10_concentration"],
    [{}, { bundlerRate: 0.300_001 }, "bundler_rate"],
    [{}, { insiderRate: 0.300_001 }, "insider_rate"],
    [{}, { devTeamHoldRate: 0.150_001 }, "dev_hold"],
    [{}, { creatorBalanceRate: 0.150_001 }, "creator_hold"],
    [{}, { isWashTrading: true }, "wash_trading"],
  ];
  for (const [securityOverride, sourceOverride, reason] of cases) {
    const curveSource = trench(sourceOverride);
    const result = evaluateSafety({
      lifecycle: "curve",
      security: security(securityOverride),
      sources: [curveSource],
      curveSource,
      hasSafeTrenches: true,
      config: config.risk_filters,
    });
    assert.deepEqual(result, { status: "reject", reason });
  }
  const dangerousCurveSource = trench({ bundlerRate: 0.31 });
  assert.deepEqual(
    evaluateSafety({
      lifecycle: "curve",
      security: security(),
      sources: [],
      curveSource: dangerousCurveSource,
      hasSafeTrenches: true,
      config: config.risk_filters,
    }),
    { status: "reject", reason: "bundler_rate" },
  );
});

test("Security missing-field policy keeps curve exceptions and requires graduated LP proof", () => {
  const missingBundler = without(trench(), "bundlerRate");
  assert.deepEqual(
    evaluateSafety({
      lifecycle: "curve",
      security: security(),
      sources: [missingBundler],
      curveSource: missingBundler,
      hasSafeTrenches: true,
      config: config.risk_filters,
    }),
    { status: "wait", reason: "bundler_missing" },
  );
  const completeCurveSource = trench();
  assert.equal(
    evaluateSafety({
      lifecycle: "curve",
      security: without(without(security(), "isOwnerRenounced"), "lockPercent"),
      sources: [completeCurveSource],
      curveSource: completeCurveSource,
      hasSafeTrenches: true,
      config: config.risk_filters,
    }).status,
    "pass",
  );
  const rankRiskFallback = rank({
    bundlerRate: 0.1,
    insiderRate: 0.1,
    devTeamHoldRate: 0.1,
    creatorBalanceRate: 0.1,
  });
  assert.deepEqual(
    evaluateSafety({
      lifecycle: "curve",
      security: security(),
      sources: [missingBundler, rankRiskFallback],
      curveSource: missingBundler,
      hasSafeTrenches: true,
      config: config.risk_filters,
    }),
    { status: "wait", reason: "bundler_missing" },
    "a stale or different source must not fill a missing curve-specific risk field",
  );
  assert.deepEqual(
    evaluateSafety({
      lifecycle: "graduated",
      security: without(security(), "isOwnerRenounced"),
      sources: [rank()],
      hasSafeTrenches: false,
      config: config.risk_filters,
    }),
    { status: "wait", reason: "owner_status_missing" },
  );
  assert.deepEqual(
    evaluateSafety({
      lifecycle: "graduated",
      security: security({ lockPercent: 0.49 }),
      sources: [rank()],
      hasSafeTrenches: false,
      config: config.risk_filters,
    }),
    { status: "reject", reason: "lp_not_secured" },
  );
  assert.equal(
    evaluateSafety({
      lifecycle: "graduated",
      security: without(security({ burnStatus: "burn" }), "lockPercent"),
      sources: [rank()],
      hasSafeTrenches: false,
      config: config.risk_filters,
    }).status,
    "pass",
  );
  const conflictingLp = rank({ lockPercent: 0.2, burnStatus: "yes" });
  assert.deepEqual(
    evaluateSafety({
      lifecycle: "graduated",
      security: security({ lockPercent: 0.8, burnStatus: "burn" }),
      sources: [conflictingLp],
      sourceSecurity: [conflictingLp],
      hasSafeTrenches: false,
      config: config.risk_filters,
    }),
    { status: "reject", reason: "lp_not_secured" },
    "LP conflicts must choose the more dangerous evidence",
  );
});

test("candidate waits for fresh Security and stale Security never qualifies", () => {
  const market = {
    trenches: [],
    rank1m: [
      observation(NOW - 5_000, rank({ rank: 25, holderCount: 100, smartDegenCount: 0 })),
      observation(NOW, rank({ rank: 10, holderCount: 103, smartDegenCount: 1 })),
    ],
    rank5m: [],
    sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
  } as const;
  assert.equal(evaluateDetector(input({ market })).action, "security_pending");
  assert.equal(
    evaluateDetector(
      input({ market, security: { capturedAt: NOW - 10_001, value: security() } }),
    ).action,
    "security_pending",
  );
  assert.equal(
    evaluateDetector(input({ market, security: { capturedAt: NOW - 10_000, value: security() } }))
      .action,
    "qualified",
  );
});

test("post-Security rank and curve fallback rules cancel at exact boundaries", () => {
  const rankReference: CandidateReference = {
    trigger: "fast_rank",
    lifecycle: "graduated",
    priority: "normal",
    qualifiedAt: NOW - 5_000,
    rank1m: 10,
    rank1Swaps: 100,
    rank1HolderCount: 100,
    securityPassedAt: NOW - 4_000,
  };
  const rankDecision = evaluateDetector(
    input({
      state: "security_pending",
      candidate: rankReference,
      market: {
        trenches: [],
        rank1m: [observation(NOW, rank({ rank: 25, swaps: 100 }))],
        rank5m: [],
        sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
      },
      security: { capturedAt: NOW, value: security() },
    }),
  );
  assert.equal(rankDecision.action, "cancelled");
  assert.equal(rankDecision.reason, "rank_fallback");

  const curveReference: CandidateReference = {
    trigger: "curve_acceleration",
    lifecycle: "curve",
    priority: "normal",
    qualifiedAt: NOW - 5_000,
    bondingProgress: 0.2,
    curveHolderCount: 20,
    curveNetBuyTotal: 10,
    securityPassedAt: NOW - 4_000,
  };
  const curveDecision = evaluateDetector(
    input({
      state: "security_pending",
      candidate: curveReference,
      market: {
        trenches: [observation(NOW, trench())],
        rank1m: [],
        rank5m: [],
        sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
      },
      security: { capturedAt: NOW, value: security() },
    }),
  );
  assert.equal(curveDecision.reason, "curve_momentum_stopped");
});

test("move classes have non-overlapping exact boundaries", () => {
  const discovery = { discoveredAt: NOW - 10_000, price: 1, marketCap: 100 };
  assert.equal(classifyMove("graduated", discovery, 1.299_999), "normal");
  assert.equal(classifyMove("graduated", discovery, 1.3), "fast_rise");
  assert.equal(classifyMove("graduated", discovery, 2), "fast_rise");
  assert.equal(classifyMove("graduated", discovery, 2.000_001), "observation_only");
  assert.equal(classifyMove("curve", discovery, undefined, 149.999), "normal");
  assert.equal(classifyMove("curve", discovery, undefined, 150), "fast_rise");
  assert.equal(classifyMove("curve", discovery, undefined, 199.999), "fast_rise");
  assert.equal(classifyMove("curve", discovery, undefined, 200), "observation_only");
});

test("double-rank confirmation edits the sent lifecycle and can make a direct candidate high priority", () => {
  const candidate: CandidateReference = {
    trigger: "cross_source",
    lifecycle: "graduated",
    priority: "normal",
    qualifiedAt: NOW - 8_000,
    rank1m: 5,
    rank5m: 40,
    rank1HolderCount: 100,
    rank1Swaps: 100,
    securityPassedAt: NOW - 7_000,
  };
  const market = {
    trenches: [],
    rank1m: [
      observation(NOW - 1_000, rank({ rank: 16, holderCount: 103, swaps: 110 })),
      observation(NOW, rank({ rank: 15, holderCount: 104, swaps: 111 })),
    ],
    rank5m: [
      observation(NOW - 1_000, rank({ interval: "5m", rank: 38 })),
      observation(NOW, rank({ interval: "5m", rank: 37 })),
    ],
    current: {
      rank1m: rank({ rank: 5, holderCount: 104, swaps: 111 }),
      rank5m: rank({ interval: "5m", rank: 37 }),
    },
    currentCapturedAt: { rank_1m: NOW, rank_5m: NOW },
    sourceFresh: { trenches: false, rank_1m: true, rank_5m: true },
  } as const;
  const sent = evaluateDetector(input({ state: "sent", candidate, market }));
  assert.equal(sent.action, "confirmed");
  assert.equal(sent.nextState, "confirmed");

  const direct = evaluateDetector(
    input({
      market: {
        ...market,
        rank1m: [
          observation(NOW - 5_000, rank({ rank: 30, holderCount: 100, swaps: 100 })),
          observation(NOW - 1_000, rank({ rank: 20, holderCount: 103, swaps: 110 })),
          observation(NOW, rank({ rank: 15, holderCount: 104, swaps: 111 })),
        ],
        rank5m: [
          observation(NOW - 5_000, rank({ interval: "5m", rank: 45 })),
          observation(NOW - 1_000, rank({ interval: "5m", rank: 43 })),
          observation(NOW, rank({ interval: "5m", rank: 42 })),
        ],
      },
      security: { capturedAt: NOW, value: security() },
    }),
  );
  assert.equal(direct.action, "qualified");
  assert.equal(direct.evidence?.priority, "high");
  assert.equal(direct.reason, "direct_double_rank");
});

test("noise limits sort high priority first and do not share an unknown Creator key", () => {
  const selection = selectWithinNoiseLimits(
    [
      { tokenKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", priority: "normal", triggeredAt: NOW },
      { tokenKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", priority: "high", triggeredAt: NOW },
    ],
    [
      { tokenKey: "old-a", priority: "normal", sentAt: NOW - 10_000 },
      { tokenKey: "old-b", priority: "normal", sentAt: NOW - 5_000 },
    ],
    NOW,
    config.noise,
  );
  assert.deepEqual(selection.accepted.map((item) => item.priority), ["high"]);
  assert.equal(selection.suppressed[0]?.reason, "global_signal_limit");

  const unknownCreators = selectWithinNoiseLimits(
    [
      { tokenKey: "0xcccccccccccccccccccccccccccccccccccccccc", priority: "normal", triggeredAt: NOW },
      { tokenKey: "0xdddddddddddddddddddddddddddddddddddddddd", priority: "normal", triggeredAt: NOW },
    ],
    [],
    NOW,
    config.noise,
  );
  assert.equal(unknownCreators.accepted.length, 2);

  const creatorCooldown = selectWithinNoiseLimits(
    [{ tokenKey: TOKEN, creatorAddress: CREATOR, priority: "high", triggeredAt: NOW }],
    [
      {
        tokenKey: "old",
        creatorAddress: CREATOR,
        priority: "normal",
        sentAt: NOW - config.noise.creator_cooldown + 1,
      },
      {
        tokenKey: "other",
        creatorAddress: OTHER_CREATOR,
        priority: "normal",
        sentAt: NOW - 5_000,
      },
    ],
    NOW,
    config.noise,
  );
  assert.equal(creatorCooldown.suppressed[0]?.reason, "creator_cooldown");

  const creatorExpired = selectWithinNoiseLimits(
    [{ tokenKey: TOKEN, creatorAddress: CREATOR, priority: "normal", triggeredAt: NOW }],
    [
      {
        tokenKey: "old",
        creatorAddress: CREATOR,
        priority: "normal",
        sentAt: NOW - config.noise.creator_cooldown,
      },
    ],
    NOW,
    config.noise,
  );
  assert.equal(creatorExpired.accepted.length, 1);
});

test("state machine blocks duplicate first signals but allows unsent outcomes to re-evaluate", () => {
  assert.equal(canTransitionSignalState("sent", "security_pending"), false);
  assert.equal(canTransitionSignalState("rejected", "security_pending"), true);
  assert.equal(
    evaluateDetector(input({ state: "delivery_unknown" })).action,
    "no_change",
  );

  const reevaluated = evaluateDetector(
    input({
      state: "rejected",
      market: {
        trenches: [],
        rank1m: [
          observation(NOW - 5_000, rank({ rank: 25, holderCount: 100, smartDegenCount: 0 })),
          observation(NOW, rank({ rank: 10, holderCount: 103, smartDegenCount: 1 })),
        ],
        rank5m: [],
        sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
      },
    }),
  );
  assert.equal(reevaluated.action, "security_pending");
});

test("Security preheat remains candidate-scoped", () => {
  const rankCandidate = input({
    market: {
      trenches: [],
      rank1m: [observation(NOW, rank({ rank: 30 }))],
      rank5m: [],
      sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
    },
  });
  assert.equal(shouldPreheatSecurity(rankCandidate), true);
  const curveCandidate = input({
    market: {
      trenches: [observation(NOW, trench({ curveSwapsTotal: 10, holderCount: 10, curveNetBuyTotal: 1 }))],
      rank1m: [],
      rank5m: [],
      sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
    },
  });
  assert.equal(shouldPreheatSecurity(curveCandidate), true);
  assert.equal(shouldPreheatSecurity(input()), false);
});

test("research cohort accepts only candidates that pass the production safety rules", () => {
  const market = {
    trenches: [observation(NOW, trench())],
    rank1m: [],
    rank5m: [],
    sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
  };
  assert.equal(
    passesResearchSafety(
      input({ market, security: { capturedAt: NOW, value: security() } }),
    ),
    true,
  );
  assert.equal(
    passesResearchSafety(
      input({ market, security: { capturedAt: NOW, value: security({ isHoneypot: true }) } }),
    ),
    false,
  );
  assert.equal(passesResearchSafety(input({ market })), false);
});

test("curve trigger rejects every just-below boundary and accepts smart-money alternative", () => {
  const base = trench({
    holderCount: 17,
    curveSwapsTotal: 10,
    curveNetBuyTotal: 5,
    bondingProgress: 0.18,
  });
  const triggerFor = (current: TrenchesToken) =>
    detectTrigger(
      input({
        market: {
          trenches: [observation(NOW - 5_000, base), observation(NOW, current)],
          rank1m: [],
          rank5m: [],
          sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
        },
      }),
    );
  const failures = [
    trench({ curveSwapsTotal: 19 }),
    trench({ holderCount: 19 }),
    trench({ curveNetBuyTotal: 0 }),
    trench({ bondingProgress: 0.199_999 }),
    trench({ holderCount: 19, curveSwapsTotal: 20 }),
    trench({ curveNetBuyTotal: 5 }),
  ];
  for (const current of failures) {
    assert.equal(triggerFor(current), null);
  }
  const lowSwapGrowth = input({
    market: {
      trenches: [
        observation(NOW - 5_000, trench({ curveSwapsTotal: 11, holderCount: 17, curveNetBuyTotal: 5, bondingProgress: 0.18 })),
        observation(NOW, trench({ curveSwapsTotal: 20 })),
      ],
      rank1m: [],
      rank5m: [],
      sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
    },
  });
  assert.equal(detectTrigger(lowSwapGrowth), null);
  const smartAlternative = input({
    ...lowSwapGrowth,
    market: {
      ...lowSwapGrowth.market,
      trenches: [
        observation(NOW - 5_000, trench({ curveSwapsTotal: 11, holderCount: 17, curveNetBuyTotal: 5, bondingProgress: 0.18 })),
        observation(NOW, trench({ curveSwapsTotal: 20, smartDegenCount: 1 })),
      ],
    },
  });
  assert.equal(detectTrigger(smartAlternative)?.trigger, "curve_acceleration");
  const stale = input({
    market: {
      trenches: [observation(NOW - 15_001, base), observation(NOW, trench())],
      rank1m: [],
      rank5m: [],
      sourceFresh: { trenches: true, rank_1m: false, rank_5m: false },
    },
  });
  assert.equal(detectTrigger(stale), null);
});

test("rank triggers reject each failed ranking, direction, participation, and freshness boundary", () => {
  const fastTriggerFor = (before: RankToken, current: RankToken, sourceFresh = true) =>
    detectTrigger(
      input({
        market: {
          trenches: [],
          rank1m: [observation(NOW - 5_000, before), observation(NOW, current)],
          rank5m: [],
          sourceFresh: { trenches: false, rank_1m: sourceFresh, rank_5m: false },
        },
      }),
    )?.trigger;
  const fastBefore = rank({ rank: 25, holderCount: 100, smartDegenCount: 0 });
  assert.notEqual(
    fastTriggerFor(fastBefore, rank({ rank: 11, holderCount: 103, smartDegenCount: 1 })),
    "fast_rank",
  );
  assert.notEqual(
    fastTriggerFor(rank({ rank: 17, holderCount: 100 }), rank({ rank: 10, holderCount: 103, smartDegenCount: 1 })),
    "fast_rank",
  );
  assert.notEqual(
    fastTriggerFor(fastBefore, rank({ rank: 10, holderCount: 103, smartDegenCount: 1, buys: 30, sells: 30 })),
    "fast_rank",
  );
  assert.notEqual(
    fastTriggerFor(fastBefore, rank({ rank: 10, holderCount: 102, smartDegenCount: 1 })),
    "fast_rank",
  );
  assert.notEqual(
    fastTriggerFor(fastBefore, rank({ rank: 10, holderCount: 103, smartDegenCount: 0 })),
    "fast_rank",
  );
  assert.equal(
    fastTriggerFor(fastBefore, rank({ rank: 10, holderCount: 103, smartDegenCount: 1 }), false),
    undefined,
  );

  const crossTriggerFor = (
    before: RankToken,
    current: RankToken,
    rank5Value: RankToken | null = rank({ interval: "5m", rank: 80 }),
  ) =>
    detectTrigger(
      input({
        market: {
          trenches: [],
          rank1m: [observation(NOW - 5_000, before), observation(NOW, current)],
          rank5m: [observation(NOW, rank5Value)],
          sourceFresh: { trenches: false, rank_1m: true, rank_5m: true },
        },
      }),
    )?.trigger;
  const crossBefore = rank({ rank: 40, holderCount: 100, swaps: 100 });
  assert.notEqual(crossTriggerFor(crossBefore, rank({ rank: 31, holderCount: 103 })), "cross_source");
  assert.notEqual(
    crossTriggerFor(rank({ rank: 34, holderCount: 100 }), rank({ rank: 30, holderCount: 103 })),
    "cross_source",
  );
  assert.notEqual(
    crossTriggerFor(crossBefore, rank({ rank: 30, holderCount: 103, buys: 30, sells: 30 })),
    "cross_source",
  );
  assert.notEqual(
    crossTriggerFor(crossBefore, rank({ rank: 30, holderCount: 102, swaps: 109 })),
    "cross_source",
  );
  assert.notEqual(
    crossTriggerFor(crossBefore, rank({ rank: 30, holderCount: 103 }), null),
    "cross_source",
  );
});

test("all cancellation paths and Security degradation fail closed", () => {
  const reference: CandidateReference = {
    trigger: "fast_rank",
    lifecycle: "graduated",
    priority: "normal",
    qualifiedAt: NOW - 5_000,
    rank1m: 10,
    rank1Swaps: 100,
    rank1HolderCount: 100,
    securityPassedAt: NOW - 4_000,
  };
  const run = (
    current: RankToken | null,
    options: { readonly missing?: number; readonly securityValue?: SecuritySnapshot } = {},
  ) =>
    evaluateDetector(
      input({
        state: "security_pending",
        candidate: reference,
        market: {
          trenches: [],
          rank1m: [observation(NOW, current)],
          rank5m: [],
          sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
          rank1mMissingSuccesses: options.missing ?? 0,
        },
        security: { capturedAt: NOW, value: options.securityValue ?? security() },
      }),
    ).reason;
  assert.equal(run(rank({ rank: 10, buys: 30, sells: 30 })), "buy_pressure_lost");
  assert.equal(run(rank({ rank: 10, swaps: 60 })), "swap_drop");
  assert.equal(run(null, { missing: 2 }), "rank_left_top100");
  assert.equal(run(rank({ rank: 10 }), { securityValue: security({ isHoneypot: true }) }), "security_degraded:honeypot");
});

test("Security rejects every dangerous field and treats exact 50 percent LP lock as sufficient", () => {
  const source = rank();
  const cases: readonly [SecuritySnapshot, RankToken, string][] = [
    [security({ isOpenSource: false }), source, "source_not_open"],
    [security({ isBlacklist: true }), source, "blacklist_enabled"],
    [security(), rank({ rugRatio: 0.300_001 }), "rug_ratio"],
    [security(), rank({ ratTraderRate: 0.300_001 }), "rat_trader_rate"],
    [security(), rank({ entrapmentRatio: 0.300_001 }), "entrapment_ratio"],
    [security(), rank({ isHoneypot: true }), "honeypot"],
    [security(), rank({ isOpenSource: false }), "source_not_open"],
    [security(), rank({ isOwnerRenounced: false }), "owner_not_renounced"],
  ];
  for (const [securityValue, rankValue, reason] of cases) {
    assert.deepEqual(
      evaluateSafety({
        lifecycle: "graduated",
        security: securityValue,
        sources: [rankValue],
        sourceSecurity: [rankValue],
        hasSafeTrenches: false,
        config: config.risk_filters,
      }),
      { status: "reject", reason },
    );
  }
  assert.equal(
    evaluateSafety({
      lifecycle: "graduated",
      security: security({ lockPercent: 0.5 }),
      sources: [source],
      hasSafeTrenches: false,
      config: config.risk_filters,
    }).status,
    "pass",
  );
});

test("detector rejects mismatched token and Rank source inputs", () => {
  assert.throws(
    () =>
      evaluateDetector(
        input({
          market: {
            trenches: [],
            rank1m: [observation(NOW, rank({ tokenKey: CREATOR, address: CREATOR }))],
            rank5m: [],
            sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
          },
        }),
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      evaluateDetector(
        input({
          market: {
            trenches: [],
            rank1m: [observation(NOW, rank({ interval: "5m" }))],
            rank5m: [],
            sourceFresh: { trenches: false, rank_1m: true, rank_5m: false },
          },
        }),
      ),
    /interval/,
  );
});

test("a high-priority overlap remains high while waiting for Security", () => {
  const curvePresence = trench({ bondingProgress: 0.2 });
  const market = {
    trenches: [observation(NOW, curvePresence)],
    rank1m: [
      observation(NOW - 5_000, rank({ rank: 25, holderCount: 100 })),
      observation(NOW, rank({ rank: 10, holderCount: 103 })),
    ],
    rank5m: [],
    sourceFresh: { trenches: true, rank_1m: true, rank_5m: false },
  } as const;
  const pending = evaluateDetector(input({ market }));
  assert.equal(pending.action, "security_pending");
  assert.equal(pending.evidence?.priority, "high");
  assert.ok(pending.evidence?.reference);

  const later = NOW + 11_000;
  const qualified = evaluateDetector(
    input({
      now: later,
      state: "security_pending",
      candidate: pending.evidence?.reference,
      market: {
        ...market,
        trenches: [
          observation(NOW, curvePresence),
          observation(later, trench({ bondingProgress: 0.201 })),
        ],
      },
      security: { capturedAt: later, value: security() },
    }),
  );
  assert.equal(qualified.action, "qualified");
  assert.equal(qualified.evidence?.priority, "high");
});
