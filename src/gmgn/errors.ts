export type GmgnErrorKind =
  | "network"
  | "timeout"
  | "http"
  | "api"
  | "rate_limit"
  | "response_too_large"
  | "invalid_json"
  | "contract";

export class GmgnError extends Error {
  public constructor(
    public readonly kind: GmgnErrorKind,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "GmgnError";
  }
}

export class GmgnHttpError extends GmgnError {
  public constructor(public readonly status: number, retryable: boolean) {
    super("http", `GMGN request failed with HTTP ${status}`, retryable);
    this.name = "GmgnHttpError";
  }
}

export class GmgnApiError extends GmgnError {
  public constructor(
    public readonly apiCode: number,
    public readonly apiError?: string,
  ) {
    super("api", `GMGN API returned non-success code ${apiCode}`, false);
    this.name = "GmgnApiError";
  }
}

export class GmgnRateLimitError extends GmgnError {
  public constructor(
    public readonly cooldownUntil: number,
    public readonly source: "header" | "body" | "fallback",
  ) {
    super("rate_limit", "GMGN rate limit is active", false);
    this.name = "GmgnRateLimitError";
  }
}

export class GmgnContractError extends GmgnError {
  public constructor(message: string) {
    super("contract", message, false);
    this.name = "GmgnContractError";
  }
}
