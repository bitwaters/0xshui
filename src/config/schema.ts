import { z } from "zod";

const DURATION_MULTIPLIERS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

const BYTE_MULTIPLIERS = {
  KB: 1_024,
  MB: 1_048_576,
  GB: 1_073_741_824,
} as const;

function parseUnitValue(
  value: unknown,
  units: Readonly<Record<string, number>>,
  label: string,
): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be a positive integer or unit string`);
  }

  const normalized = value.trim();
  const unitAlternation = Object.keys(units).join("|");
  const match = new RegExp(`^(\\d+(?:\\.\\d+)?)(${unitAlternation})$`, "i").exec(normalized);
  if (match === null) {
    throw new Error(`${label} has an unsupported unit`);
  }

  const amount = Number(match[1]);
  const canonicalUnit = Object.keys(units).find(
    (unit) => unit.toLowerCase() === match[2]?.toLowerCase(),
  );
  const multiplier = canonicalUnit === undefined ? undefined : units[canonicalUnit];
  const result = multiplier === undefined ? Number.NaN : amount * multiplier;

  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} is outside the supported range`);
  }

  return result;
}

const durationMsSchema = z.unknown().transform((value, context) => {
  try {
    return parseUnitValue(value, DURATION_MULTIPLIERS, "duration");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid duration",
    });
    return z.NEVER;
  }
});

const byteSizeSchema = z.unknown().transform((value, context) => {
  try {
    return parseUnitValue(value, BYTE_MULTIPLIERS, "byte size");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid byte size",
    });
    return z.NEVER;
  }
});

const ratioSchema = z.number().finite().min(0).max(1);
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();

const uniqueArray = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

export const appConfigSchema = z
  .object({
    chain: z.literal("bsc"),
    mode: z.enum(["shadow", "production"]),
    poll_interval: durationMsSchema,
    report_timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, { message: "report_timezone must be a valid IANA time zone" }),
    logging: z
      .object({
        level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
      })
      .strict(),
    telegram: z
      .object({
        enabled: z.boolean(),
        daily_report: z.boolean(),
      })
      .strict(),
    gmgn: z
      .object({
        transport: z.literal("direct_http"),
        base_url: z.string().url().refine((value) => value === "https://openapi.gmgn.ai", {
          message: "gmgn.base_url must use the official OpenAPI host",
        }),
        user_agent: z.string().trim().min(1).max(128),
        request_timeout: durationMsSchema,
        network_retry: z.literal(1),
        max_response_size: byteSizeSchema,
        local_weight_limit_per_second: z.number().int().min(4).max(20),
        security_cache: durationMsSchema,
        security_max_age_at_send: durationMsSchema,
        security_max_concurrency: z.number().int().min(1).max(10),
        source_max_age_for_trigger: durationMsSchema,
      })
      .strict(),
    trenches: z
      .object({
        limit_per_stage: z.literal(80),
        types: z
          .array(z.enum(["new_creation", "near_completion", "completed"]))
          .length(3)
          .refine(uniqueArray, { message: "trenches.types must not contain duplicates" }),
        filter_preset: z.literal("safe"),
      })
      .strict(),
    rank: z
      .object({
        limit: z.literal(100),
        security_preheat_rank_1m: z.number().int().min(1).max(100),
        intervals: z
          .array(z.enum(["1m", "5m"]))
          .length(2)
          .refine(uniqueArray, { message: "rank.intervals must not contain duplicates" }),
        filters: z.union([
          z.tuple([z.literal("not_honeypot")]),
          // Historical config versions remain parseable for deterministic replay.
          z.tuple([
            z.literal("not_honeypot"),
            z.literal("verified"),
            z.literal("renounced"),
          ]),
        ]),
      })
      .strict(),
    risk_filters: z
      .object({
        max_rug: ratioSchema,
        max_bundler: ratioSchema,
        max_insider: ratioSchema,
        max_rat_trader: ratioSchema,
        max_entrapment: ratioSchema,
        max_dev_hold: ratioSchema,
        max_creator_hold: ratioSchema,
        max_top10: ratioSchema,
        max_buy_tax: ratioSchema,
        max_sell_tax: ratioSchema,
      })
      .strict(),
    curve_preheat: z
      .object({
        min_curve_swaps_total: positiveIntegerSchema,
        min_holders: positiveIntegerSchema,
        require_positive_curve_net_buy_total: z.literal(true),
      })
      .strict(),
    curve_trigger: z
      .object({
        window: durationMsSchema,
        min_curve_swaps_total: positiveIntegerSchema,
        min_holders: positiveIntegerSchema,
        min_progress_growth: ratioSchema,
        min_holder_growth: positiveIntegerSchema,
        min_curve_swap_growth: positiveIntegerSchema,
        require_positive_curve_net_buy_growth: z.literal(true),
      })
      .strict(),
    fast_rank_trigger: z
      .object({
        window: durationMsSchema,
        max_rank_1m: z.number().int().min(1).max(100),
        min_rank_improvement: positiveIntegerSchema,
        min_fresh_snapshots: z.number().int().min(2).max(10),
      })
      .strict(),
    cross_source_trigger: z
      .object({
        max_rank_1m: z.number().int().min(1).max(100),
        min_rank_improvement: positiveIntegerSchema,
        max_rank_5m: z.number().int().min(1).max(100),
      })
      .strict(),
    mature_momentum: z
      .object({
        live_delivery: z.boolean(),
        min_age: durationMsSchema,
        min_liquidity: z.number().finite().positive(),
        max_rank_1m: z.number().int().min(1).max(100),
        max_rank_5m: z.number().int().min(1).max(100),
        window: durationMsSchema,
        min_rank_improvement: positiveIntegerSchema,
        sustain_rank_1m: z.number().int().min(1).max(100),
        max_rank_fallback: positiveIntegerSchema,
        sample_target: z.number().int().min(1).max(1_000),
      })
      .strict()
      .default({
        live_delivery: false,
        min_age: 3_600_000,
        min_liquidity: 30_000,
        max_rank_1m: 20,
        max_rank_5m: 40,
        window: 60_000,
        min_rank_improvement: 3,
        sustain_rank_1m: 10,
        max_rank_fallback: 5,
        sample_target: 30,
      }),
    confirmation: z
      .object({
        max_rank_1m: z.number().int().min(1).max(100),
        max_rank_5m: z.number().int().min(1).max(100),
        max_rank_1m_fallback: positiveIntegerSchema.default(5),
        min_rank_1m_improvement: positiveIntegerSchema.optional(),
        min_rank_5m_improvement: positiveIntegerSchema.optional(),
        min_fresh_snapshots: z.number().int().min(2).max(10).optional(),
      })
      .strict(),
    cancel: z
      .object({
        rank_fallback: positiveIntegerSchema,
        swap_drop: ratioSchema,
        missing_rank_snapshots: z.number().int().min(1).max(10),
      })
      .strict(),
    noise: z
      .object({
        max_initial_signals_per_minute: positiveIntegerSchema,
        max_normal_signals_per_minute: nonNegativeIntegerSchema,
        reserved_high_priority_slots: nonNegativeIntegerSchema,
        creator_cooldown: durationMsSchema,
        one_message_per_token: z.literal(true),
        edit_message_on_confirmation: z.literal(true),
      })
      .strict(),
    outcomes: z
      .object({
        checkpoints: z.array(durationMsSchema).length(2),
        hit_window: durationMsSchema,
        hit_gain: z.number().finite().positive().max(100),
        large_gain_window: durationMsSchema,
        large_gain: z.number().finite().positive().max(100),
      })
      .strict(),
    storage: z
      .object({
        sqlite_path: z.string().trim().min(1).max(512),
        snapshot_retention: durationMsSchema,
        signal_retention: durationMsSchema,
        baseline_snapshot_interval: durationMsSchema,
        sqlite_soft_limit: byteSizeSchema,
        incremental_vacuum: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.mode === "production" && !config.telegram.enabled) {
      context.addIssue({
        code: "custom",
        path: ["telegram", "enabled"],
        message: "telegram.enabled must be true in production mode",
      });
    }

    if (config.gmgn.security_max_age_at_send > config.gmgn.security_cache) {
      context.addIssue({
        code: "custom",
        path: ["gmgn", "security_max_age_at_send"],
        message: "security_max_age_at_send cannot exceed security_cache",
      });
    }

    if (
      config.noise.max_normal_signals_per_minute +
        config.noise.reserved_high_priority_slots !==
      config.noise.max_initial_signals_per_minute
    ) {
      context.addIssue({
        code: "custom",
        path: ["noise"],
        message: "normal capacity plus reserved slots must equal the total signal limit",
      });
    }

    if (config.curve_preheat.min_curve_swaps_total > config.curve_trigger.min_curve_swaps_total) {
      context.addIssue({
        code: "custom",
        path: ["curve_preheat", "min_curve_swaps_total"],
        message: "curve preheat swaps cannot exceed the trigger threshold",
      });
    }

    if (config.curve_preheat.min_holders > config.curve_trigger.min_holders) {
      context.addIssue({
        code: "custom",
        path: ["curve_preheat", "min_holders"],
        message: "curve preheat holders cannot exceed the trigger threshold",
      });
    }

    const [firstCheckpoint, secondCheckpoint] = config.outcomes.checkpoints;
    if (
      firstCheckpoint !== config.outcomes.hit_window ||
      secondCheckpoint !== config.outcomes.large_gain_window ||
      firstCheckpoint >= secondCheckpoint
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomes", "checkpoints"],
        message: "checkpoints must match the ordered hit and large-gain windows",
      });
    }
  });

export type AppConfig = z.output<typeof appConfigSchema>;

export function configForSignalVersion(config: Readonly<AppConfig>): AppConfig {
  return {
    ...config,
    mode: "shadow",
    telegram: { ...config.telegram, enabled: false },
  };
}

export function parseAppConfig(input: unknown): AppConfig {
  return appConfigSchema.parse(input);
}
