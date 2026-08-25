import { GmgnContractError } from "./errors.js";

const BSC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeBscAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !BSC_ADDRESS_PATTERN.test(value)) {
    throw new GmgnContractError(`${field} must be a valid BSC address`);
  }
  return value.toLowerCase();
}

export function optionalAddress(value: unknown, field: string): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : normalizeBscAddress(value, field);
}

export function finiteNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new GmgnContractError(`${field} must be a finite number`);
  }
  return parsed;
}

export function nonNegativeNumber(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (parsed < 0) {
    throw new GmgnContractError(`${field} must not be negative`);
  }
  return parsed;
}

export function positiveNumber(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (parsed <= 0) {
    throw new GmgnContractError(`${field} must be positive`);
  }
  return parsed;
}

export function integer(value: unknown, field: string, minimum = 0): number {
  const parsed = finiteNumber(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new GmgnContractError(`${field} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function ratio(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (parsed < 0 || parsed > 1) {
    throw new GmgnContractError(`${field} must be between 0 and 1`);
  }
  return parsed;
}

export function explicitBoolean(value: unknown, field: string): boolean {
  if (value === true || value === 1 || value === "1" || value === "yes" || value === "true") {
    return true;
  }
  if (value === false || value === 0 || value === "0" || value === "no" || value === "false") {
    return false;
  }
  throw new GmgnContractError(`${field} must be an explicit boolean value`);
}

export function optionalValue<T>(
  value: unknown,
  parser: (input: unknown) => T,
): T | undefined {
  return value === undefined || value === null || value === "" ? undefined : parser(value);
}

export function timestampMs(value: unknown, field: string): number {
  const parsed = integer(value, field, 1);
  const milliseconds = parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new GmgnContractError(`${field} timestamp is outside the supported range`);
  }
  return milliseconds;
}

export function optionalTimestampMs(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") {
    return undefined;
  }
  return timestampMs(value, field);
}

export function optionalText(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maximum);
}

export function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GmgnContractError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
