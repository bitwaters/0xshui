import { randomUUID } from "node:crypto";

import {
  GmgnApiError,
  GmgnContractError,
  GmgnError,
  GmgnHttpError,
  GmgnRateLimitError,
} from "./errors.js";
import type { RankInterval } from "./models.js";
import { normalizeBscAddress } from "./normalize.js";

const DEFAULT_FALLBACK_COOLDOWN_MS = 5 * 60_000;
const MAX_ACCEPTED_RESET_MS = 24 * 60 * 60_000;
const BSC_TRENCHES_QUOTE_TYPES = [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0] as const;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GmgnClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetchImplementation?: FetchImplementation;
  readonly now?: () => number;
  readonly uuid?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly beforeAttempt?: (context: GmgnRequestAttempt) => Promise<void>;
  readonly onRateLimit?: (error: GmgnRateLimitError) => Promise<void>;
  readonly onAttemptCompleted?: (metric: GmgnRequestMetric) => void;
}

export interface GmgnRequestAttempt {
  readonly path: string;
  readonly attempt: 1 | 2;
}

export interface GmgnRequestMetric {
  readonly path: string;
  readonly durationMs: number;
  readonly success: boolean;
}

export interface GmgnRawResponse {
  readonly data: unknown;
  readonly envelopeDepth: 1 | 2;
  readonly receivedAt: number;
  readonly serverDateMs: number | null;
}

interface RequestSpec {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | readonly string[]>>;
  readonly body?: unknown;
}

interface Envelope {
  readonly code: unknown;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly reset_at?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is Envelope {
  return isRecord(value) && "code" in value && "data" in value;
}

export function unwrapSuccessEnvelope(value: unknown): {
  readonly data: unknown;
  readonly depth: 1 | 2;
} {
  if (!isRecord(value) || !("code" in value)) {
    throw new GmgnContractError("GMGN response is not a supported success envelope");
  }
  if (value.code !== 0) {
    const apiCode = typeof value.code === "number" && Number.isFinite(value.code) ? value.code : -1;
    const apiError = typeof value.error === "string" ? value.error.slice(0, 64) : undefined;
    throw new GmgnApiError(apiCode, apiError);
  }
  if (!("data" in value)) {
    throw new GmgnContractError("GMGN success envelope is missing data");
  }

  if (!isEnvelope(value.data)) {
    return { data: value.data, depth: 1 };
  }
  if (value.data.code !== 0) {
    const apiCode =
      typeof value.data.code === "number" && Number.isFinite(value.data.code)
        ? value.data.code
        : -1;
    const apiError = typeof value.data.error === "string" ? value.data.error.slice(0, 64) : undefined;
    throw new GmgnApiError(apiCode, apiError);
  }
  if (isEnvelope(value.data.data)) {
    throw new GmgnContractError("GMGN response contains an unsupported third envelope");
  }
  return { data: value.data.data, depth: 2 };
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new GmgnError("response_too_large", "GMGN response exceeded the configured limit");
    }
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw new GmgnError("response_too_large", "GMGN response exceeded the configured limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GmgnError("invalid_json", "GMGN response was not valid JSON");
  }
}

function parseServerDate(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validReset(value: unknown, now: number): number | null {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(raw)) {
    return null;
  }
  const milliseconds = raw < 1_000_000_000_000 ? raw * 1_000 : raw;
  return milliseconds > now && milliseconds <= now + MAX_ACCEPTED_RESET_MS ? milliseconds : null;
}

function resolveCooldown(response: Response, body: unknown, now: number): GmgnRateLimitError {
  const headerReset = validReset(response.headers.get("x-ratelimit-reset"), now);
  if (headerReset !== null) {
    return new GmgnRateLimitError(headerReset, "header");
  }
  const bodyRecord = findRateLimitRecord(body);
  const bodyReset = bodyRecord === null ? null : validReset(bodyRecord.reset_at, now);
  if (bodyReset !== null) {
    return new GmgnRateLimitError(bodyReset, "body");
  }
  return new GmgnRateLimitError(now + DEFAULT_FALLBACK_COOLDOWN_MS, "fallback");
}

function isRateLimitRecord(body: unknown): body is Record<string, unknown> {
  if (!isRecord(body)) {
    return false;
  }
  return (
    body.code === 429 ||
    body.error === "RATE_LIMIT_EXCEEDED" ||
    body.error === "RATE_LIMIT_BANNED"
  );
}

function findRateLimitRecord(body: unknown): Record<string, unknown> | null {
  if (isRateLimitRecord(body)) {
    return body;
  }
  if (isRecord(body) && isRateLimitRecord(body.data)) {
    return body.data;
  }
  return null;
}

function isRateLimited(response: Response, body: unknown): boolean {
  return response.status === 429 || findRateLimitRecord(body) !== null;
}

export class GmgnHttpClient {
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  public constructor(private readonly options: GmgnClientOptions) {
    if (options.baseUrl !== "https://openapi.gmgn.ai") {
      throw new GmgnContractError("GMGN client requires the official OpenAPI host");
    }
    if (options.apiKey.trim() === "") {
      throw new GmgnContractError("GMGN API key is required");
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  public fetchTrenches(): Promise<GmgnRawResponse> {
    const section = {
      filters: ["offchain", "onchain"],
      launchpad_platform_v2: true,
      limit: 80,
      max_rug_ratio: 0.3,
      max_bundler_rate: 0.3,
      max_insider_ratio: 0.3,
      quote_address_type: BSC_TRENCHES_QUOTE_TYPES,
    };
    return this.request({
      method: "POST",
      path: "/v1/trenches",
      query: { chain: "bsc" },
      body: {
        version: "v2",
        new_creation: section,
        near_completion: section,
        completed: section,
      },
    });
  }

  public fetchRank(interval: RankInterval, limit = 100): Promise<GmgnRawResponse> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Rank limit must be an integer between 1 and 100");
    }
    return this.request({
      method: "GET",
      path: "/v1/market/rank",
      query: {
        chain: "bsc",
        interval,
        limit,
        order_by: "default",
        direction: "desc",
        filters: ["not_honeypot", "verified", "renounced"],
      },
    });
  }

  public fetchSecurity(address: string): Promise<GmgnRawResponse> {
    return this.request({
      method: "GET",
      path: "/v1/token/security",
      query: { chain: "bsc", address: normalizeBscAddress(address, "address") },
    });
  }

  public fetchPool(address: string): Promise<GmgnRawResponse> {
    return this.request({
      method: "GET",
      path: "/v1/token/pool_info",
      query: { chain: "bsc", address: normalizeBscAddress(address, "address") },
    });
  }

  public fetchKline(address: string, from: number, to: number): Promise<GmgnRawResponse> {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from <= 0 ||
      to <= from
    ) {
      throw new RangeError("Kline from/to must be ordered positive Unix seconds");
    }
    return this.request({
      method: "GET",
      path: "/v1/market/token_kline",
      query: {
        chain: "bsc",
        address: normalizeBscAddress(address, "address"),
        resolution: "30s",
        from,
        to,
      },
    });
  }

  private async request(spec: RequestSpec): Promise<GmgnRawResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.options.beforeAttempt?.({
          path: spec.path,
          attempt: (attempt + 1) as 1 | 2,
        });
        const startedAt = this.now();
        try {
          const response = await this.executeAttempt(spec);
          this.completeAttempt(spec.path, startedAt, true);
          return response;
        } catch (error) {
          this.completeAttempt(spec.path, startedAt, false);
          throw error;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof GmgnRateLimitError) {
          await this.options.onRateLimit?.(error);
        }
        const retryable = error instanceof GmgnError && error.retryable;
        if (!retryable || attempt === 1) {
          throw error;
        }
        await this.sleep(200 + Math.floor(this.random() * 301));
      }
    }
    throw lastError;
  }

  private completeAttempt(path: string, startedAt: number, success: boolean): void {
    try {
      this.options.onAttemptCompleted?.({
        path,
        durationMs: Math.max(0, this.now() - startedAt),
        success,
      });
    } catch {
      // Telemetry must never alter request behavior.
    }
  }

  private async executeAttempt(spec: RequestSpec): Promise<GmgnRawResponse> {
    const requestStartedAt = this.now();
    const url = new URL(spec.path, this.options.baseUrl);
    for (const [key, rawValue] of Object.entries({
      ...spec.query,
      timestamp: Math.floor(requestStartedAt / 1_000),
      client_id: this.uuid(),
    })) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        url.searchParams.append(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    let text: string;
    try {
      const init: RequestInit = {
        method: spec.method,
        headers: {
          "X-APIKEY": this.options.apiKey,
          "Content-Type": "application/json",
          "User-Agent": this.options.userAgent,
        },
        signal: controller.signal,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      };
      response = await this.fetchImplementation(url, init);
      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel();
        throw new GmgnHttpError(response.status, true);
      }
      if (
        response.status === 429 &&
        validReset(response.headers.get("x-ratelimit-reset"), this.now()) !== null
      ) {
        await response.body?.cancel();
        throw resolveCooldown(response, null, this.now());
      }
      try {
        text = await readLimitedBody(response, this.options.maxResponseBytes);
      } catch (error) {
        if (response.status === 429) {
          throw resolveCooldown(response, null, this.now());
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof GmgnError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new GmgnError("timeout", "GMGN request timed out", true);
      }
      throw new GmgnError("network", "GMGN network request failed", true);
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (response.status === 429) {
      const rateBody = contentType.includes("application/json") ? parseJson(text) : null;
      throw resolveCooldown(response, rateBody, this.now());
    }
    if (!contentType.includes("application/json")) {
      throw new GmgnError("invalid_json", "GMGN response content type was not JSON");
    }
    const body = parseJson(text);
    if (isRateLimited(response, body)) {
      throw resolveCooldown(response, body, this.now());
    }
    if (!response.ok) {
      throw new GmgnHttpError(response.status, false);
    }
    const unwrapped = unwrapSuccessEnvelope(body);
    return {
      data: unwrapped.data,
      envelopeDepth: unwrapped.depth,
      receivedAt: this.now(),
      serverDateMs: parseServerDate(response.headers.get("date")),
    };
  }
}

let singleton: GmgnHttpClient | undefined;

export function getGmgnHttpClient(options: GmgnClientOptions): GmgnHttpClient {
  singleton ??= new GmgnHttpClient(options);
  return singleton;
}
