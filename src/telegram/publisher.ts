import { Api, GrammyError, type InlineKeyboard } from "grammy";

import type { PersistenceRepository } from "../db/index.js";
import { classifyTelegramFailure } from "./errors.js";
import { renderSignalCard, type SignalCardModel } from "./view.js";

export interface TelegramGateway {
  readonly sendMessage: (
    chatId: string,
    text: string,
    options: { readonly parse_mode: "HTML"; readonly reply_markup: InlineKeyboard },
  ) => Promise<{ readonly message_id: number }>;
  readonly editMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    options: { readonly parse_mode: "HTML"; readonly reply_markup: InlineKeyboard },
  ) => Promise<unknown>;
}

export type FreshSignalCheck =
  | { readonly ok: true; readonly card: SignalCardModel }
  | { readonly ok: false; readonly reason: string };

export interface PublishRequest {
  readonly tokenKey: string;
  readonly recheck: () => Promise<FreshSignalCheck>;
}

export interface PublishResult {
  readonly status: "sent" | "cancelled" | "delivery_unknown" | "duplicate" | "not_sent";
  readonly attempts: number;
  readonly reason?: string;
  readonly messageId?: number;
}

export interface TelegramPublisherOptions {
  readonly api: TelegramGateway;
  readonly repository: PersistenceRepository;
  readonly chatId: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maximumAttempts?: number;
  readonly outcomeCheckpointsMs?: readonly number[];
  readonly onSent?: (
    tokenKey: string,
    lifecycle: SignalCardModel["lifecycle"],
  ) => Promise<void> | void;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function createTelegramGateway(botToken: string): TelegramGateway {
  if (botToken.trim() === "") {
    throw new Error("Telegram bot token is required");
  }
  return new Api(botToken);
}

export class TelegramPublisher {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maximumAttempts: number;

  public constructor(private readonly options: TelegramPublisherOptions) {
    if (options.chatId.trim() === "") {
      throw new Error("Telegram target chat is required");
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    if (this.maximumAttempts !== 3) {
      throw new RangeError("Telegram delivery uses exactly three maximum attempts");
    }
  }

  public async publish(request: PublishRequest): Promise<PublishResult> {
    const initial = this.options.repository.getDeliveryTarget(request.tokenKey);
    if (initial?.state !== "qualified") {
      return { status: "duplicate", attempts: initial?.attempts ?? 0 };
    }
    if (initial.attempts >= this.maximumAttempts) {
      this.options.repository.cancelQualifiedDelivery(
        request.tokenKey,
        "telegram_attempts_exhausted",
        this.now(),
      );
      return {
        status: "not_sent",
        attempts: initial.attempts,
        reason: "telegram_attempts_exhausted",
      };
    }

    for (
      let attempt = initial.attempts + 1;
      attempt <= this.maximumAttempts;
      attempt += 1
    ) {
      let checked: FreshSignalCheck;
      try {
        checked = await request.recheck();
      } catch {
        checked = { ok: false, reason: "market_recheck_failed" };
      }
      if (!checked.ok) {
        const reason = `telegram_delay_cancelled:${checked.reason}`;
        const cancelled = this.options.repository.cancelQualifiedDelivery(
          request.tokenKey,
          reason,
          this.now(),
        );
        return {
          status: cancelled ? "cancelled" : "duplicate",
          attempts: attempt - 1,
          reason,
        };
      }
      if (checked.card.tokenKey !== request.tokenKey) {
        const reason = "telegram_delay_cancelled:card_token_mismatch";
        this.options.repository.cancelQualifiedDelivery(request.tokenKey, reason, this.now());
        return { status: "cancelled", attempts: attempt - 1, reason };
      }

      let rendered: ReturnType<typeof renderSignalCard>;
      try {
        rendered = renderSignalCard(checked.card);
      } catch {
        const reason = "telegram_delay_cancelled:card_invalid";
        const cancelled = this.options.repository.cancelQualifiedDelivery(
          request.tokenKey,
          reason,
          this.now(),
        );
        return {
          status: cancelled ? "cancelled" : "duplicate",
          attempts: attempt - 1,
          reason,
        };
      }
      if (!this.options.repository.tryMarkDeliveryPending(request.tokenKey, this.now())) {
        return { status: "duplicate", attempts: attempt - 1 };
      }
      try {
        const message = await this.options.api.sendMessage(
          this.options.chatId,
          rendered.text,
          { parse_mode: "HTML", reply_markup: rendered.keyboard },
        );
        if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0) {
          return this.markUnknown(request.tokenKey, "telegram_success_without_message_id", attempt);
        }
        try {
          if (
            !this.options.repository.markSent(
              request.tokenKey,
              message.message_id,
              this.now(),
              checked.card.price,
              checked.card.marketCap,
              this.options.outcomeCheckpointsMs,
            )
          ) {
            return this.markUnknown(request.tokenKey, "telegram_sent_state_conflict", attempt);
          }
        } catch {
          return this.markUnknown(request.tokenKey, "telegram_sent_persistence_failed", attempt);
        }
        if (checked.card.lifecycle === "graduated" && this.options.onSent !== undefined) {
          try {
            void Promise.resolve(
              this.options.onSent(request.tokenKey, checked.card.lifecycle),
            ).catch(() => undefined);
          } catch {
            // Pool baseline capture is intentionally asynchronous and never blocks delivery.
          }
        }
        return { status: "sent", attempts: attempt, messageId: message.message_id };
      } catch (error) {
        const failure = classifyTelegramFailure(error);
        if (failure.acceptance === "ambiguous") {
          return this.markUnknown(request.tokenKey, failure.reason, attempt);
        }
        if (failure.retryable && attempt < this.maximumAttempts) {
          const released = this.options.repository.releaseDeliveryForRetry(
            request.tokenKey,
            failure.reason,
            this.now(),
          );
          if (!released) {
            return this.markUnknown(request.tokenKey, "telegram_retry_state_conflict", attempt);
          }
          const delay = failure.retryAfterMs > 0 ? failure.retryAfterMs : attempt * 250;
          await this.sleep(delay);
          continue;
        }
        this.options.repository.markDeliveryNotSent(request.tokenKey, failure.reason, this.now());
        return { status: "not_sent", attempts: attempt, reason: failure.reason };
      }
    }
    return { status: "not_sent", attempts: this.maximumAttempts, reason: "attempts_exhausted" };
  }

  public async confirm(tokenKey: string, card: SignalCardModel): Promise<boolean> {
    if (card.tokenKey !== tokenKey) {
      throw new Error("Confirmation card token does not match tokenKey");
    }
    const target = this.options.repository.getDeliveryTarget(tokenKey);
    if (target?.state !== "sent" || target.telegramMessageId === null) {
      return false;
    }
    const rendered = renderSignalCard({ ...card, confirmed: true });
    try {
      await this.options.api.editMessageText(
        this.options.chatId,
        target.telegramMessageId,
        rendered.text,
        { parse_mode: "HTML", reply_markup: rendered.keyboard },
      );
    } catch (error) {
      if (
        !(error instanceof GrammyError) ||
        !error.description.toLowerCase().includes("message is not modified")
      ) {
        return false;
      }
    }
    try {
      return (
        this.options.repository.markConfirmed(tokenKey, this.now()) ||
        this.options.repository.getDeliveryTarget(tokenKey)?.state === "confirmed"
      );
    } catch {
      return false;
    }
  }

  private markUnknown(tokenKey: string, reason: string, attempts: number): PublishResult {
    try {
      this.options.repository.markDeliveryUnknown(tokenKey, reason, this.now());
    } catch {
      // The caller still receives an ambiguous result and must never retry automatically.
    }
    return { status: "delivery_unknown", attempts, reason };
  }
}
