import type { PersistenceRepository } from "../db/index.js";
import {
  adaptSecurity,
  GmgnError,
  type GmgnHttpClient,
  type SecuritySnapshot,
} from "../gmgn/index.js";
import type { TokenWindowStore } from "./snapshot-store.js";

export interface CachedSecurity {
  readonly snapshot: SecuritySnapshot;
  readonly capturedAt: number;
}

interface SecurityJob {
  readonly tokenKey: string;
  urgent: boolean;
  readonly promise: Promise<SecuritySnapshot | null>;
  readonly resolve: (value: SecuritySnapshot | null) => void;
}

export interface SecurityManagerOptions {
  readonly client: GmgnHttpClient;
  readonly repository: PersistenceRepository;
  readonly windowStore: TokenWindowStore;
  readonly concurrency: number;
  readonly cacheTtlMs: number;
  readonly sendMaximumAgeMs: number;
  readonly now?: () => number;
  readonly onCompleted?: (
    tokenKey: string,
    snapshot: SecuritySnapshot | null,
    capturedAt: number,
  ) => Promise<void> | void;
}

export class SecurityManager {
  private readonly cache = new Map<string, CachedSecurity>();
  private readonly failedPreheats = new Map<string, number>();
  private readonly jobs = new Map<string, SecurityJob>();
  private readonly queue: SecurityJob[] = [];
  private active = 0;
  private readonly now: () => number;

  public constructor(private readonly options: SecurityManagerOptions) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
      throw new RangeError("Security concurrency must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  public async preheat(tokenKey: string): Promise<SecuritySnapshot | null> {
    return this.request(tokenKey, false, this.options.cacheTtlMs);
  }

  public async getFreshForSend(tokenKey: string): Promise<SecuritySnapshot | null> {
    return this.request(tokenKey, true, this.options.sendMaximumAgeMs);
  }

  public getCached(tokenKey: string): CachedSecurity | null {
    const cached = this.cache.get(tokenKey);
    if (cached === undefined || this.now() - cached.capturedAt > this.options.cacheTtlMs) {
      this.cache.delete(tokenKey);
      return null;
    }
    return cached;
  }

  public getActiveCount(): number {
    return this.active;
  }

  public getQueueSize(): number {
    return this.queue.length;
  }

  private request(
    tokenKey: string,
    urgent: boolean,
    maximumAgeMs: number,
  ): Promise<SecuritySnapshot | null> {
    this.pruneCache();
    const cached = this.cache.get(tokenKey);
    if (cached !== undefined && this.now() - cached.capturedAt <= maximumAgeMs) {
      return Promise.resolve(cached.snapshot);
    }
    const failedAt = this.failedPreheats.get(tokenKey);
    if (!urgent && failedAt !== undefined && this.now() - failedAt <= this.options.cacheTtlMs) {
      return Promise.resolve(null);
    }
    const existing = this.jobs.get(tokenKey);
    if (existing !== undefined) {
      existing.urgent ||= urgent;
      this.sortQueue();
      return existing.promise;
    }

    let resolveJob: (value: SecuritySnapshot | null) => void = () => undefined;
    const promise = new Promise<SecuritySnapshot | null>((resolve) => {
      resolveJob = resolve;
    });
    const job: SecurityJob = { tokenKey, urgent, promise, resolve: resolveJob };
    this.jobs.set(tokenKey, job);
    this.queue.push(job);
    this.sortQueue();
    this.pump();
    return promise;
  }

  private sortQueue(): void {
    this.queue.sort((left, right) => Number(right.urgent) - Number(left.urgent));
  }

  private pump(): void {
    while (this.active < this.options.concurrency) {
      const job = this.queue.shift();
      if (job === undefined) {
        return;
      }
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.jobs.delete(job.tokenKey);
        this.pump();
      });
    }
  }

  private async run(job: SecurityJob): Promise<void> {
    try {
      const raw = await this.options.client.fetchSecurity(job.tokenKey);
      const snapshot = adaptSecurity(raw.data);
      if (snapshot.tokenKey !== job.tokenKey.toLowerCase()) {
        throw new Error("Security response address did not match the requested token");
      }
      const ingestSeq = this.options.repository.appendSecurityEvent({
        tokenKey: snapshot.tokenKey,
        capturedAt: raw.receivedAt,
        status: "passed",
        payload: snapshot,
        adapterVersion: "gmgn-adapter-v1",
      });
      this.options.windowStore.add(snapshot.tokenKey, {
        ingestSeq,
        source: "security",
        eventType: "security",
        capturedAt: raw.receivedAt,
        data: snapshot,
      });
      this.cache.set(snapshot.tokenKey, { snapshot, capturedAt: raw.receivedAt });
      this.failedPreheats.delete(snapshot.tokenKey);
      job.resolve(snapshot);
      void Promise.resolve(
        this.options.onCompleted?.(snapshot.tokenKey, snapshot, raw.receivedAt),
      ).catch(() => undefined);
    } catch (error) {
      const reason = error instanceof GmgnError ? error.kind : "unknown";
      this.failedPreheats.set(job.tokenKey, this.now());
      try {
        this.options.repository.appendSecurityEvent({
          tokenKey: job.tokenKey.toLowerCase(),
          capturedAt: this.now(),
          status: "failed",
          reason,
          payload: { reason },
          adapterVersion: "gmgn-adapter-v1",
        });
      } catch {
        // A storage failure also fails closed; the caller receives no Security result.
      }
      job.resolve(null);
      void Promise.resolve(
        this.options.onCompleted?.(job.tokenKey, null, this.now()),
      ).catch(() => undefined);
    }
  }

  private pruneCache(): void {
    const cutoff = this.now() - this.options.cacheTtlMs;
    for (const [tokenKey, cached] of this.cache) {
      if (cached.capturedAt < cutoff) {
        this.cache.delete(tokenKey);
      }
    }
    for (const [tokenKey, failedAt] of this.failedPreheats) {
      if (failedAt < cutoff) {
        this.failedPreheats.delete(tokenKey);
      }
    }
  }
}
