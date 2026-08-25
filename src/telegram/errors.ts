import { GrammyError, HttpError } from "grammy";

export interface TelegramFailure {
  readonly acceptance: "definitively_not_accepted" | "ambiguous";
  readonly retryable: boolean;
  readonly reason: string;
  readonly retryAfterMs: number;
}

export function classifyTelegramFailure(error: unknown): TelegramFailure {
  if (error instanceof GrammyError) {
    const retryable = error.error_code === 429 || error.error_code >= 500;
    const retryAfterSeconds = error.parameters.retry_after;
    const retryAfterMs =
      retryable && retryAfterSeconds !== undefined && Number.isSafeInteger(retryAfterSeconds)
        ? Math.min(Math.max(retryAfterSeconds, 0) * 1_000, 30_000)
        : 0;
    return {
      acceptance: "definitively_not_accepted",
      retryable,
      reason: `telegram_api_${error.error_code}`,
      retryAfterMs,
    };
  }
  if (error instanceof HttpError) {
    return {
      acceptance: "ambiguous",
      retryable: false,
      reason: "telegram_http_ambiguous",
      retryAfterMs: 0,
    };
  }
  return {
    acceptance: "ambiguous",
    retryable: false,
    reason: "telegram_unknown_ambiguous",
    retryAfterMs: 0,
  };
}
