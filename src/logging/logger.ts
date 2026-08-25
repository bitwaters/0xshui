import { randomUUID } from "node:crypto";

import pino, {
  type DestinationStream,
  type LevelWithSilent,
  type Logger as PinoLogger,
} from "pino";

import type { OperationalEvent } from "./events.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "…[truncated]";
const MAX_STRING_LENGTH = 512;
const MAX_ARRAY_LENGTH = 32;
const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 6;

type LogContext = Readonly<Record<string, unknown>>;
type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  readonly level: Exclude<LevelWithSilent, "silent">;
  readonly service?: string;
  readonly secrets?: readonly string[];
  readonly destination?: DestinationStream;
}

function redactText(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result.length > MAX_STRING_LENGTH
    ? `${result.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
    : result;
}

function safeError(error: Error, secrets: readonly string[]): LogContext {
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    name: redactText(error.name, secrets),
    message: redactText(error.message, secrets),
    ...(code === undefined ? {} : { code: redactText(code, secrets) }),
  };
}

function sanitizeValue(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    return safeError(value, secrets);
  }
  if (depth >= MAX_DEPTH) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, secrets, depth + 1, seen));
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`[${value.length - MAX_ARRAY_LENGTH} more items]`);
    }
    return items;
  }

  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    const normalizedKey = redactText(key, secrets);
    const shouldRedact = /api[-_]?key|token|secret|authorization|x-apikey|client_id|timestamp/i.test(
      key,
    );
    sanitized[normalizedKey] = shouldRedact
      ? REDACTED
      : sanitizeValue(child, secrets, depth + 1, seen);
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    sanitized._truncated_keys = Object.keys(value).length - MAX_OBJECT_KEYS;
  }
  return sanitized;
}

function sanitizeContext(context: LogContext, secrets: readonly string[]): LogContext {
  const sanitized = sanitizeValue(context, secrets);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as LogContext)
    : { value: sanitized };
}

export class AppLogger {
  public constructor(
    private readonly base: PinoLogger,
    private readonly secrets: readonly string[],
  ) {}

  public withCorrelationId(correlationId: string = randomUUID()): AppLogger {
    return this.child({ correlation_id: correlationId });
  }

  public child(context: LogContext): AppLogger {
    return new AppLogger(this.base.child(sanitizeContext(context, this.secrets)), this.secrets);
  }

  public debug(event: OperationalEvent, context: LogContext = {}): void {
    this.write("debug", event, context);
  }

  public info(event: OperationalEvent, context: LogContext = {}): void {
    this.write("info", event, context);
  }

  public warn(event: OperationalEvent, context: LogContext = {}): void {
    this.write("warn", event, context);
  }

  public error(event: OperationalEvent, error: unknown, context: LogContext = {}): void {
    const errorContext = error instanceof Error ? { error } : { error: String(error) };
    this.write("error", event, { ...context, ...errorContext });
  }

  private write(level: LogLevel, event: OperationalEvent, context: LogContext): void {
    const payload = {
      ...sanitizeContext(context, this.secrets),
      event,
    };
    this.base[level](payload, event);
  }
}

export function createLogger(options: LoggerOptions): AppLogger {
  const base = pino(
    {
      level: options.level,
      base: {
        service: options.service ?? "gmgn-bsc-signal-bot",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
  return new AppLogger(base, options.secrets ?? []);
}
