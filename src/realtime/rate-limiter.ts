import type { PersistenceRepository } from "../db/index.js";
import type { GmgnRateLimitError, GmgnRequestAttempt } from "../gmgn/index.js";

export type RequestPriority = "realtime" | "security" | "offline";

export interface RateLimiterOptions {
  readonly ratePerSecond: number;
  readonly capacity: number;
  readonly initialCooldownUntil?: number | null;
  readonly repository: PersistenceRepository;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const PATH_POLICY: Readonly<Record<string, { weight: number; priority: RequestPriority }>> = {
  "/v1/trenches": { weight: 3, priority: "realtime" },
  "/v1/market/rank": { weight: 1, priority: "realtime" },
  "/v1/token/security": { weight: 1, priority: "security" },
  "/v1/market/token_kline": { weight: 2, priority: "offline" },
  "/v1/token/pool_info": { weight: 1, priority: "offline" },
};

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class WeightedRateLimiter {
  private tokens: number;
  private lastRefillAt: number;
  private cooldownUntil: number | null;
  private recoveryStartedAt: number | null;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly stopPromise: Promise<void>;
  private readonly resolveStop: () => void;
  private stopped = false;

  public constructor(private readonly options: RateLimiterOptions) {
    if (
      !Number.isFinite(options.ratePerSecond) ||
      options.ratePerSecond <= 0 ||
      !Number.isFinite(options.capacity) ||
      options.capacity <= 0
    ) {
      throw new RangeError("Rate limiter capacity and rate must be positive");
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    let resolveStop: () => void = () => undefined;
    this.stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    this.resolveStop = resolveStop;
    this.tokens = options.capacity;
    this.lastRefillAt = this.now();
    this.cooldownUntil = options.initialCooldownUntil ?? null;
    this.recoveryStartedAt = this.cooldownUntil;
  }

  public beforeAttempt = async (context: GmgnRequestAttempt): Promise<void> => {
    const policy = PATH_POLICY[context.path];
    if (policy === undefined) {
      throw new Error(`No rate-limit policy for GMGN path ${context.path}`);
    }
    await this.acquire(policy.weight, policy.priority);
  };

  public onRateLimit = async (error: GmgnRateLimitError): Promise<void> => {
    this.enterCooldown(error.cooldownUntil);
  };

  public enterCooldown(until: number): void {
    if (!Number.isSafeInteger(until) || until <= this.now()) {
      throw new RangeError("Cooldown deadline must be a future millisecond timestamp");
    }
    this.cooldownUntil = Math.max(this.cooldownUntil ?? 0, until);
    this.recoveryStartedAt = this.cooldownUntil;
    this.tokens = 0;
    this.lastRefillAt = this.now();
    this.options.repository.setRuntimeState("gmgn_cooldown_until", this.cooldownUntil);
  }

  public getCooldownUntil(): number | null {
    return this.cooldownUntil;
  }

  public stop(): void {
    if (!this.stopped) {
      this.stopped = true;
      this.resolveStop();
    }
  }

  public async acquire(weight: number, priority: RequestPriority): Promise<void> {
    if (!Number.isFinite(weight) || weight <= 0 || weight > this.options.capacity) {
      throw new RangeError("Request weight must be positive and not exceed limiter capacity");
    }

    while (true) {
      if (this.stopped) throw new Error("Rate limiter stopped");
      const now = this.now();
      if (this.cooldownUntil !== null) {
        if (now < this.cooldownUntil) {
          await this.wait(this.cooldownUntil - now);
          continue;
        }
        this.recoveryStartedAt = this.cooldownUntil;
        this.cooldownUntil = null;
        this.options.repository.setRuntimeState("gmgn_cooldown_until", null, now);
      }

      const stageDelay = this.recoveryDelay(priority, now);
      if (stageDelay > 0) {
        await this.wait(stageDelay);
        continue;
      }

      this.refill(now);
      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }
      const missing = weight - this.tokens;
      await this.wait(Math.max(1, Math.ceil((missing / this.options.ratePerSecond) * 1_000)));
    }
  }

  private recoveryDelay(priority: RequestPriority, now: number): number {
    if (this.recoveryStartedAt === null) {
      return 0;
    }
    const delay = priority === "realtime" ? 0 : priority === "security" ? 1_000 : 2_000;
    const remaining = this.recoveryStartedAt + delay - now;
    if (remaining <= 0 && priority === "offline") {
      this.recoveryStartedAt = null;
    }
    return Math.max(remaining, 0);
  }

  private refill(now: number): void {
    if (now <= this.lastRefillAt) {
      return;
    }
    const elapsed = Math.max(now - this.lastRefillAt, 0);
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (elapsed / 1_000) * this.options.ratePerSecond,
    );
    this.lastRefillAt = now;
  }

  private async wait(milliseconds: number): Promise<void> {
    await Promise.race([this.sleep(milliseconds), this.stopPromise]);
    if (this.stopped) throw new Error("Rate limiter stopped");
  }
}
