import type {
  PendingOutcomeJob,
  PendingResearchOutcomeJob,
  PersistenceRepository,
} from "../db/index.js";
import type { PoolSnapshot, TrenchesToken } from "../gmgn/index.js";
import { calculateOutcome, fixedTerminalOutcome } from "./calculator.js";
import type {
  CalculatedOutcome,
  GraduationStatus,
  OutcomeDataSource,
  PoolLookup,
} from "./types.js";

const GRACE_MS = 10 * 60_000;
const RETRY_MS = 3 * 60_000;
const FRESH_TRENCHES_MS = 10_000;

type WorkerJob =
  | (PendingOutcomeJob & { readonly kind: "signal" })
  | {
      readonly kind: "research";
      readonly researchSampleId: number;
      readonly tokenKey: string;
      readonly lifecycle: "curve" | "graduated";
      readonly checkpointMs: number;
      readonly dueAt: number;
      readonly attemptCount: number;
      readonly sentAt: number;
      readonly sentPrice: number;
      readonly poolBaseline: null;
    };

function isPoolSnapshot(value: unknown): value is PoolSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "tokenKey" in value &&
    typeof value.tokenKey === "string" &&
    "poolAddress" in value &&
    typeof value.poolAddress === "string" &&
    "liquidity" in value &&
    typeof value.liquidity === "number" &&
    value.liquidity > 0
  );
}

function asTrenchesToken(value: unknown): TrenchesToken | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("stage" in value) ||
    !("tokenKey" in value)
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.stage !== "new_creation" &&
      candidate.stage !== "near_completion" &&
      candidate.stage !== "completed") ||
    typeof candidate.tokenKey !== "string" ||
    (candidate.curveSwapsTotal !== undefined &&
      (typeof candidate.curveSwapsTotal !== "number" ||
        !Number.isSafeInteger(candidate.curveSwapsTotal) ||
        candidate.curveSwapsTotal < 0))
  ) {
    return null;
  }
  return value as TrenchesToken;
}

function curveEvidence(
  evidence: readonly { readonly capturedAt: number; readonly payload: unknown }[],
  dueAt: number,
  expectedTokenKey: string,
): {
  readonly noTrade: boolean;
  readonly graduation: GraduationStatus;
} {
  const parsed = evidence
    .map((item) => ({ capturedAt: item.capturedAt, token: asTrenchesToken(item.payload) }))
    .filter(
      (item): item is { capturedAt: number; token: TrenchesToken } =>
        item.token !== null && item.token.tokenKey === expectedTokenKey,
    );
  const completed = parsed.some(
    (item) => item.capturedAt <= dueAt && item.token.stage === "completed",
  );
  if (completed) {
    return { noTrade: false, graduation: "graduated" };
  }
  const before = parsed.findLast((item) => item.capturedAt < dueAt);
  const after = parsed.find((item) => item.capturedAt >= dueAt);
  const nearDue = parsed.findLast(
    (item) =>
      Math.abs(item.capturedAt - dueAt) <= FRESH_TRENCHES_MS &&
      item.token.stage !== "completed",
  );
  const noTrade =
    before?.token.curveSwapsTotal !== undefined &&
    after?.token.curveSwapsTotal !== undefined &&
    dueAt - before.capturedAt <= FRESH_TRENCHES_MS &&
    after.capturedAt - dueAt <= FRESH_TRENCHES_MS &&
    before.token.curveSwapsTotal === after.token.curveSwapsTotal;
  return {
    noTrade,
    graduation: nearDue === undefined ? "unknown" : "not_graduated",
  };
}

function terminalPoolState(
  baseline: unknown,
  lookup: PoolLookup,
): "no_trade" | "pool_removed" | "api_missing" {
  if (lookup.status === "found" && lookup.pool.liquidity > 0) {
    return "no_trade";
  }
  if (
    lookup.status === "found" &&
    lookup.pool.liquidity === 0 &&
    !lookup.hasAlternativePool &&
    isPoolSnapshot(baseline) &&
    lookup.pool.poolAddress === baseline.poolAddress
  ) {
    return "pool_removed";
  }
  if (
    lookup.status === "missing" &&
    !lookup.hasAlternativePool &&
    isPoolSnapshot(baseline)
  ) {
    return "pool_removed";
  }
  return "api_missing";
}

export interface OutcomeWorkerOptions {
  readonly repository: PersistenceRepository;
  readonly dataSource: OutcomeDataSource;
  readonly now?: () => number;
}

export class OutcomeWorker {
  private readonly now: () => number;
  private running = false;

  public constructor(private readonly options: OutcomeWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  public async capturePoolBaseline(tokenKey: string): Promise<boolean> {
    try {
      const result = await this.options.dataSource.fetchPool(tokenKey);
      return result.status === "found" &&
        result.pool.tokenKey === tokenKey &&
        result.pool.liquidity > 0
        ? this.options.repository.savePoolBaseline(tokenKey, result.pool, this.now())
        : false;
    } catch {
      return false;
    }
  }

  public async runDue(limit = 20): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const signalJobs = this.options.repository
        .listDueOutcomeJobs(this.now(), limit)
        .map((job): WorkerJob => ({ ...job, kind: "signal" }));
      const remaining = limit - signalJobs.length;
      const researchJobs =
        remaining <= 0
          ? []
          : this.options.repository
              .listDueResearchOutcomeJobs(this.now(), remaining)
              .map((job): WorkerJob => this.researchJob(job));
      const jobs = [...signalJobs, ...researchJobs];
      for (const job of jobs) {
        await this.runJob(job);
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private researchJob(job: PendingResearchOutcomeJob): WorkerJob {
    return {
      kind: "research",
      researchSampleId: job.researchSampleId,
      tokenKey: job.tokenKey,
      lifecycle: job.lifecycle,
      checkpointMs: job.checkpointMs,
      dueAt: job.dueAt,
      attemptCount: job.attemptCount,
      sentAt: job.sampledAt,
      sentPrice: job.baselinePrice,
      poolBaseline: null,
    };
  }

  private async runJob(job: WorkerJob): Promise<void> {
    const now = this.now();
    const attempt = job.attemptCount + 1;
    if (job.sentPrice === null || !Number.isFinite(job.sentPrice) || job.sentPrice <= 0) {
      this.complete(job, "api_missing", attempt, { reason: "sent_price_missing" }, now);
      return;
    }
    try {
      const candles = await this.options.dataSource.fetchKlines(
        job.tokenKey,
        Math.floor(job.sentAt / 1_000),
        Math.ceil(job.dueAt / 1_000),
      );
      if (candles.length > 0) {
        const realtime = this.options.repository.getRealtimePrices(
          job.tokenKey,
          job.sentAt,
          Math.ceil(job.sentAt / 30_000) * 30_000,
        );
        const result: CalculatedOutcome = calculateOutcome(
          job.sentAt,
          job.sentPrice,
          job.checkpointMs,
          candles,
          realtime,
        );
        const requiredReturns =
          job.checkpointMs === 15 * 60_000
            ? [result.return1m, result.return5m, result.return15m]
            : [result.return1h];
        if (result.candleCount === 0 || requiredReturns.some((value) => value === undefined)) {
          this.retryOrComplete(job, attempt, "api_missing", "kline_checkpoint_incomplete", now);
          return;
        }
        const graduation =
          job.lifecycle === "curve" && job.checkpointMs === 60 * 60_000
            ? curveEvidence(
                this.options.repository.getTrenchesEvidence(
                  job.tokenKey,
                  job.sentAt,
                  now,
                ),
                job.dueAt,
                job.tokenKey,
              ).graduation
            : undefined;
        this.complete(
          job,
          "completed",
          attempt,
          graduation === undefined ? result : { ...result, graduation },
          now,
        );
        return;
      }

      if (job.lifecycle === "graduated") {
        const pool = await this.options.dataSource.fetchPool(job.tokenKey);
        if (pool.status === "found" && pool.pool.tokenKey !== job.tokenKey) {
          throw new Error("Pool response token mismatch");
        }
        const state = terminalPoolState(job.poolBaseline, pool);
        if (state === "api_missing") {
          this.complete(job, state, attempt, { reason: "pool_evidence_missing" }, now);
        } else {
          const value = state === "pool_removed" ? -1 : 0;
          this.complete(job, state, attempt, fixedTerminalOutcome(job.checkpointMs, value), now);
        }
        return;
      }

      const curve = curveEvidence(
        this.options.repository.getTrenchesEvidence(job.tokenKey, job.dueAt - 10_000, now),
        job.dueAt,
        job.tokenKey,
      );
      if (curve.graduation === "graduated") {
        const pool = await this.options.dataSource.fetchPool(job.tokenKey);
        if (pool.status === "found" && pool.pool.tokenKey !== job.tokenKey) {
          throw new Error("Pool response token mismatch");
        }
        const state = terminalPoolState(job.poolBaseline, pool);
        if (state === "api_missing") {
          this.complete(job, state, attempt, { reason: "pool_evidence_missing" }, now);
        } else {
          const value = state === "pool_removed" ? -1 : 0;
          this.complete(
            job,
            state,
            attempt,
            { ...fixedTerminalOutcome(job.checkpointMs, value), graduation: "graduated" },
            now,
          );
        }
        return;
      }
      if (curve.noTrade) {
        this.complete(
          job,
          "no_trade",
          attempt,
          { ...fixedTerminalOutcome(job.checkpointMs, 0), graduation: curve.graduation },
          now,
        );
        return;
      }
      this.retryOrComplete(job, attempt, "api_missing", "curve_evidence_missing", now);
    } catch {
      this.retryOrComplete(job, attempt, "retry_exhausted", "market_api_failed", now);
    }
  }

  private retryOrComplete(
    job: WorkerJob,
    attempt: number,
    terminalState: "api_missing" | "retry_exhausted",
    reason: string,
    now: number,
  ): void {
    const graceUntil = job.dueAt + GRACE_MS;
    if (attempt < 3 && now < graceUntil) {
      this.save(job, {
        state: "pending",
        attemptCount: attempt,
        nextAttemptAt: Math.min(now + RETRY_MS, graceUntil),
        result: { reason },
        now,
      });
      return;
    }
    this.complete(job, terminalState, attempt, { reason }, now);
  }

  private complete(
    job: WorkerJob,
    state: "completed" | "no_trade" | "pool_removed" | "api_missing" | "retry_exhausted",
    attemptCount: number,
    result: unknown,
    now: number,
  ): void {
    this.save(job, {
      state,
      attemptCount: Math.min(attemptCount, 3),
      result,
      completedAt: now,
      now,
    });
  }

  private save(
    job: WorkerJob,
    value: {
      readonly state: "pending" | "completed" | "no_trade" | "pool_removed" | "api_missing" | "retry_exhausted";
      readonly attemptCount: number;
      readonly nextAttemptAt?: number;
      readonly result: unknown;
      readonly completedAt?: number;
      readonly now: number;
    },
  ): void {
    const common = {
      checkpointMs: job.checkpointMs,
      dueAt: job.dueAt,
      state: value.state,
      attemptCount: value.attemptCount,
      ...(value.nextAttemptAt === undefined ? {} : { nextAttemptAt: value.nextAttemptAt }),
      result: value.result,
      ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
      now: value.now,
    };
    if (job.kind === "signal") {
      this.options.repository.saveOutcome({ signalId: job.signalId, ...common });
    } else {
      this.options.repository.saveResearchOutcome({
        researchSampleId: job.researchSampleId,
        ...common,
      });
    }
  }
}
